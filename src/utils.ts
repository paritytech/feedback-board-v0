import { useState, useEffect } from "react";
import {
    createAccountsProvider,
    hostApi as productSdkHostApi,
    preimageManager,
    requestPermission,
    type ProductAccount,
} from "@novasamatech/product-sdk";
import { enumValue, RequestCredentialsErr } from "@novasamatech/host-api";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import { ss58ToH160 } from "@parity/product-sdk-address";
import { createClient, AccountId, Binary, type PolkadotSigner, type PolkadotClient, type TypedApi } from "polkadot-api";
import { getWsProvider } from "@polkadot-api/ws-provider";
import { blake2b } from "@noble/hashes/blake2.js";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import type { MultihashDigest } from "multiformats/hashes/interface";
import { ethers } from "ethers";

// Paseo Asset Hub Next (v2). v1 retired 2026-05-20.
const PASEO_ASSET_HUB_WS = "wss://paseo-asset-hub-next-rpc.polkadot.io";

// ---------------------------------------------------------------------------
// Permissions (RFC-0002)
// ---------------------------------------------------------------------------

const _grantedPermissions = new Set<string>();

async function ensurePermission(tag: "ChainSubmit" | "PreimageSubmit" | "StatementSubmit") {
    if (_grantedPermissions.has(tag)) return;
    try {
        const result = await requestPermission({ tag, value: undefined });
        if (result.isOk() && result.value) {
            _grantedPermissions.add(tag);
        } else {
            console.warn(`[Permission] ${tag} denied`);
        }
    } catch (err) {
        console.warn(`[Permission] ${tag} request failed:`, err);
    }
}

// ---------------------------------------------------------------------------
// Resource allocation (host-api 0.7.9+).
//
// Modern Polkadot Desktop/Mobile hosts gate Revive contract calls behind a
// `SmartContractAllowance` budget that has to be allocated PER account, once
// per session. Without this, the host silently rejects contract transactions
// (the error often surfaces as `RpcError: No active follow for this chain`,
// which obscures the real cause — the allowance was never granted).
//
// We also request `AutoSigning` so subsequent contract calls don't require a
// per-tx confirmation prompt on the phone. The host may return `NotAvailable`
// for AutoSigning (not implemented in every host build); that's fine and
// expected — only SmartContractAllowance is critical.
// ---------------------------------------------------------------------------

const _allocatedAccounts = new Set<string>();

async function ensureResourceAllocation(account: AppAccount): Promise<void> {
    if (_allocatedAccounts.has(account.address)) return;
    try {
        const request = enumValue("v1", [
            { tag: "SmartContractAllowance", value: 0 },
            { tag: "AutoSigning", value: undefined },
        ]) as never;

        const outcomes = await productSdkHostApi.requestResourceAllocation(request).match(
            (response: any) => response.value as Array<{ tag: string }>,
            (err: unknown) => {
                console.warn("[Allowance] requestResourceAllocation rejected:", err);
                return [] as Array<{ tag: string }>;
            },
        );

        const [smartContract, autoSigning] = outcomes;
        const msg = `SmartContractAllowance=${smartContract?.tag ?? "?"}, AutoSigning=${autoSigning?.tag ?? "?"}`;
        if (smartContract?.tag === "Allocated") {
            _allocatedAccounts.add(account.address);
            console.info(`[Allowance] granted — ${msg}`);
        } else {
            console.warn(`[Allowance] NOT granted — ${msg} (contract tx will likely fail)`);
        }
    } catch (err) {
        console.warn("[Allowance] requestResourceAllocation threw:", err);
    }
}

// ---------------------------------------------------------------------------
// Account flow — directly against @novasamatech/product-sdk (matches RPS/t3rminal).
// @parity/product-sdk-signer is intentionally avoided because its SignerManager
// goes through getLegacyAccounts() which the new Polkadot Desktop/Mobile hosts
// reject for product apps.
// ---------------------------------------------------------------------------

const accountsProvider = createAccountsProvider();
const accountIdCodec = AccountId();

// Polkadot Desktop registers each product by the URL it's loaded from. The
// signer-side identifier check is strict, so we must mirror the host's own
// derivation exactly (matches playground-app/src/config.ts):
//   localhost          → host:port  (e.g. "localhost:3000")
//   <name>.dot.li      → "<name>.dot"  (Bulletin gateway, including previews)
//   <name>.dot         → "<name>.dot"  (direct Polkadot Browser navigation)
//   anything else      → fallback "feedback-board.dot"
function getProductIdentifier(): string | null {
    if (typeof window === "undefined") return null;
    const hostname = window.location.hostname.toLowerCase();
    if (!hostname) return null;
    if (hostname === "localhost") return window.location.host;
    if (hostname.endsWith(".dot.li")) return hostname.slice(0, -3);
    if (hostname.endsWith(".dot")) return hostname;
    return "feedback-board.dot";
}

export function getAppAccountId(): [string, number] {
    const identifier = getProductIdentifier() ?? "feedback-board.dot";
    return [identifier, 0];
}

export interface AppAccount {
    address: string;
    h160Address: string;
    publicKey: Uint8Array;
    name: string | null;
    signer: PolkadotSigner;
    productAccountId: [string, number];
    productAccount: ProductAccount;
    getSigner(): PolkadotSigner;
}

interface AccountState {
    status: "idle" | "connecting" | "ready" | "signed-out" | "error";
    account: AppAccount | null;
    error?: string;
}

let _state: AccountState = { status: "idle", account: null };
const _listeners = new Set<(s: AccountState) => void>();

function setState(next: AccountState) {
    _state = next;
    for (const cb of _listeners) cb(next);
}

export function useAccountState(): AccountState {
    const [state, set] = useState<AccountState>(_state);
    useEffect(() => {
        const cb = (s: AccountState) => set(s);
        _listeners.add(cb);
        return () => { _listeners.delete(cb); };
    }, []);
    return state;
}

export async function connectAccount(): Promise<void> {
    if (_state.status === "connecting") return;
    setState({ status: "connecting", account: null });

    try {
        const [identifier, derivationIndex] = getAppAccountId();
        const result = await accountsProvider.getProductAccount(identifier, derivationIndex);
        if (result.isErr()) {
            if (result.error instanceof RequestCredentialsErr.NotConnected) {
                setState({ status: "signed-out", account: null });
                return;
            }
            const errMsg = `${(result.error as any)?.tag ?? "Unknown"}: ${(result.error as any)?.value?.reason ?? String(result.error)}`;
            setState({ status: "error", account: null, error: errMsg });
            return;
        }

        const { publicKey } = result.value;
        const productAccount: ProductAccount = { dotNsIdentifier: identifier, derivationIndex, publicKey };
        // "createTransaction" path routes via host_create_transaction and preserves
        // pallet-revive's Paseo Next v2 signed extensions (AsPgas, AsRingAlias, …).
        // PJS-style "signPayload" strips them and the chain rejects the tx.
        // Requires Polkadot Desktop ≥ 0.3.10.
        const signer = accountsProvider.getProductAccountSigner(productAccount, "createTransaction");
        const ss58 = accountIdCodec.dec(publicKey);
        const h160Address = ss58ToH160(ss58 as never) as `0x${string}`;

        let displayName: string | null = null;
        try {
            const userIdResult = await accountsProvider.getUserId();
            if (userIdResult.isOk()) {
                displayName = (userIdResult.value as any).primaryUsername ?? null;
            }
        } catch { /* optional */ }

        const account: AppAccount = {
            address: ss58,
            h160Address,
            publicKey,
            name: displayName,
            signer,
            productAccountId: [identifier, derivationIndex],
            productAccount,
            getSigner: () => signer,
        };

        setState({ status: "ready", account });

        // Request SmartContractAllowance from the host. Required before any
        // Revive contract tx; otherwise the host silently drops them.
        void ensureResourceAllocation(account);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setState({ status: "error", account: null, error: msg });
    }
}

export async function signIn(): Promise<void> {
    await accountsProvider.requestLogin("Sign in to post to the feedback board");
    await connectAccount();
}

// ---------------------------------------------------------------------------
// Bulletin upload — host preimage path (works in dev mode)
// ---------------------------------------------------------------------------

const BLAKE2B_256_CODE = 0xb220;

function encodeVarint(value: number): Uint8Array {
    const bytes: number[] = [];
    let num = value;
    while (num >= 0x80) {
        bytes.push((num & 0x7f) | 0x80);
        num >>= 7;
    }
    bytes.push(num & 0x7f);
    return new Uint8Array(bytes);
}

export function calculateCID(bytes: Uint8Array): string {
    const hash = blake2b(bytes, { dkLen: 32 });
    const codeBytes = encodeVarint(BLAKE2B_256_CODE);
    const lengthBytes = encodeVarint(hash.length);
    const multihash = new Uint8Array(codeBytes.length + lengthBytes.length + hash.length);
    multihash.set(codeBytes, 0);
    multihash.set(lengthBytes, codeBytes.length);
    multihash.set(hash, codeBytes.length + lengthBytes.length);
    const digest: MultihashDigest = {
        code: BLAKE2B_256_CODE,
        size: hash.length,
        bytes: multihash,
        digest: hash,
    };
    return CID.createV1(raw.code, digest).toString();
}

export async function uploadToBulletin(_account: AppAccount, bytes: Uint8Array): Promise<string> {
    await ensurePermission("PreimageSubmit");
    const cid = calculateCID(bytes);
    await preimageManager.submit(bytes);
    return cid;
}

// ---------------------------------------------------------------------------
// Contracts — direct ReviveApi.call + ethers.js (t3rminal pattern).
// We deliberately bypass @parity/product-sdk-contracts' ContractManager because
// its query path on Paseo Next v2 dry-runs with the user's (initially unmapped)
// origin and stalls. Using Alice as READ_ORIGIN for view calls sidesteps that;
// writes go via the Revive.call extrinsic and ensureMapping is called first.
// ---------------------------------------------------------------------------

// Alice's ss58 on Paseo — pre-mapped, used as origin for view calls only.
// ReviveApi.call requires a mapped origin even for pure reads; view functions
// don't depend on the caller's identity.
const READ_ORIGIN = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

// camelCase ⇄ snake_case bridge: cdm.json exposes ABI names in camelCase
// (`postFeedback`) while the Rust source declares them in snake_case
// (`post_feedback`). ContractManager's typed API uses camelCase already;
// ethers' Interface accepts whatever's in the ABI verbatim. We always feed it
// camelCase from cdm.json, so no conversion is needed at call sites.

interface PaseoChainAPI {
    assetHub: TypedApi<typeof paseo_asset_hub>;
    raw: { assetHub: PolkadotClient };
}

let _chainApi: PaseoChainAPI | null = null;
let _contractAddress: `0x${string}` | null = null;
let _iface: ethers.Interface | null = null;
let _cdmJson: any = null;
let _chainInitPromise: Promise<void> | null = null;

export function stageCdmJson(cdmJson: any): void {
    _cdmJson = cdmJson;
    // Extract contract address + ABI from the first target in cdm.json that
    // has our package. cdm install populates this after a successful deploy.
    const contractsByTarget = cdmJson?.contracts ?? {};
    for (const targetHash of Object.keys(contractsByTarget)) {
        const entry = contractsByTarget[targetHash]?.["@example/feedback"];
        if (entry?.address && entry?.abi) {
            _contractAddress = entry.address as `0x${string}`;
            _iface = new ethers.Interface(entry.abi);
            return;
        }
    }
    console.warn("[CDM] No deployed @example/feedback contract found in cdm.json");
}

export async function initContracts(cdmJson: any): Promise<void> {
    stageCdmJson(cdmJson);
}

async function ensureChainReady(): Promise<PaseoChainAPI> {
    if (_chainApi) return _chainApi;
    if (_chainInitPromise) {
        await _chainInitPromise;
        return _chainApi!;
    }
    _chainInitPromise = (async () => {
        await ensurePermission("ChainSubmit");
        // WS-direct (matches t3rminal). createPapiProvider advertises host
        // support for Paseo Asset Hub Next but the host doesn't establish a
        // working chainHead follow for this chain yet — every tx submit fails
        // with `RpcError: No active follow for this chain`. Going straight to
        // the public WS endpoint sidesteps that. Signing still goes through
        // the host's product-account signer; only RPC bypasses the host.
        const provider = getWsProvider(PASEO_ASSET_HUB_WS);
        const client = createClient(provider);
        _chainApi = {
            assetHub: client.getTypedApi(paseo_asset_hub),
            raw: { assetHub: client },
        };
        console.log("[Chain] Paseo Asset Hub Next client ready (WS direct)");
    })().catch(err => {
        console.error("[Chain] init failed:", err);
        _chainInitPromise = null;
        throw err;
    });
    await _chainInitPromise;
    return _chainApi!;
}

async function readContract(functionName: string, args: unknown[]): Promise<ethers.Result> {
    if (!_iface || !_contractAddress) {
        throw new Error("Contract ABI/address not loaded — did cdm install run?");
    }
    const api = await ensureChainReady();
    const calldata = _iface.encodeFunctionData(functionName, args);
    console.log(`[Read] ${functionName} → ReviveApi.call(addr=${_contractAddress}, data=${calldata.slice(0, 26)}...)`);
    try {
        await api.raw.assetHub.getBestBlocks();
        console.log(`[Read] ${functionName} chain alive, calling…`);
    } catch (err) {
        console.warn(`[Read] ${functionName} getBestBlocks failed:`, err);
    }
    const result = await api.assetHub.apis.ReviveApi.call(
        READ_ORIGIN,
        _contractAddress,
        BigInt(0),
        undefined, // gas_limit
        undefined, // storage_deposit_limit
        Binary.fromHex(calldata as `0x${string}`),
    );
    console.log(`[Read] ${functionName} → result.success=${result.result.success}`);
    if (!result.result.success) {
        throw new Error(`Contract read ${functionName} failed: ${JSON.stringify(result.result.value)}`);
    }
    const hex = Binary.toHex(result.result.value.data);
    return _iface.decodeFunctionResult(functionName, hex);
}

// Polkadot Desktop's chainHead follow gets torn down when idle and the next
// signAndSubmit lands before the host has finished re-establishing it,
// surfacing as `RpcError: No active follow for this chain`. The host *does*
// hold operations while it refollows, but a freshly-disposed follow can still
// leak through on the first attempt. Pattern (matches t3rminal):
//   1. wake with getBestBlocks() to coax the follow back up
//   2. signAndSubmit, catch only "no active follow" and try once more
//   3. let any other error propagate
async function signAndSubmitWithFollowRetry<T>(
    api: PaseoChainAPI,
    buildTx: () => { signAndSubmit: (signer: PolkadotSigner) => Promise<T> },
    signer: PolkadotSigner,
    label: string,
): Promise<T> {
    await api.raw.assetHub.getBestBlocks();
    try {
        return await buildTx().signAndSubmit(signer);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/no active follow/i.test(msg)) throw err;
        console.warn(`[${label}] chain follow lost, retrying after getBestBlocks…`);
        await api.raw.assetHub.getBestBlocks();
        return await buildTx().signAndSubmit(signer);
    }
}

async function writeContract(
    functionName: string,
    args: unknown[],
    origin: string,
    signer: PolkadotSigner,
): Promise<{ block: { hash: string; number: number } }> {
    if (!_iface || !_contractAddress) {
        throw new Error("Contract ABI/address not loaded — did cdm install run?");
    }
    if (_state.account) await ensureResourceAllocation(_state.account);
    const api = await ensureChainReady();
    const calldata = _iface.encodeFunctionData(functionName, args);

    const buildTx = () => api.assetHub.tx.Revive.call({
        dest: _contractAddress!,
        value: BigInt(0),
        weight_limit: { ref_time: BigInt("50000000000"), proof_size: BigInt("1000000") },
        storage_deposit_limit: BigInt("10000000000"),
        data: Binary.fromHex(calldata as `0x${string}`),
    });

    const result: any = await signAndSubmitWithFollowRetry(api, buildTx, signer, `Contract.${functionName}`);
    void origin;
    if (result.dispatchError) {
        throw new Error(`Revive.call dispatch error: ${JSON.stringify(result.dispatchError)}`);
    }
    return result;
}

// Public API: keeps the `fb.methodName.query(...)` / `fb.methodName.tx(...)`
// shape so call sites don't need to change.
export function getContract(): any {
    if (!_cdmJson) return null;
    return new Proxy({}, {
        get(_target, prop) {
            const fnName = String(prop);
            return {
                query: async (...args: any[]) => {
                    const decoded = await readContract(fnName, args);
                    // Mimic ContractManager's `{ success, value }` shape so the
                    // existing App.tsx callers keep working. Single-output ABIs
                    // expose `decoded[0]`; multi-output returns the array.
                    const value = decoded.length === 1 ? decoded[0] : decoded;
                    return { success: true, value };
                },
                tx: async (...args: any[]) => {
                    // Last arg is `{ signer, origin }` per the call-site convention.
                    const opts = args[args.length - 1] as { signer: PolkadotSigner; origin: string };
                    const callArgs = args.slice(0, -1);
                    return writeContract(fnName, callArgs, opts.origin, opts.signer);
                },
            };
        },
    });
}

// ---------------------------------------------------------------------------
// Revive account mapping (t3rminal pattern).
//
// pallet-revive on Paseo Next v2 requires every SS58 origin calling a contract
// to have a Revive.map_account() entry. Product accounts are not pre-mapped.
//
// Tries direct Revive.map_account() first. If that fails with a non-mapped
// error (e.g. Polkadot Desktop signing-UI TDZ crash on stale metadata), wraps
// in Utility.batch — the host's decoder may route the batch through a
// different code path and skip the broken display. AccountAlreadyMapped is
// always treated as success.
// ---------------------------------------------------------------------------

const _mappedAccounts = new Set<string>();

function isAccountAlreadyMapped(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    if (/AccountAlreadyMapped/i.test(message)) return true;
    const dispatchType = (err as { dispatchError?: { value?: { value?: { type?: string } } } })
        ?.dispatchError?.value?.value?.type;
    return dispatchType === "AccountAlreadyMapped";
}

export async function ensureMapping(account: AppAccount): Promise<void> {
    if (_mappedAccounts.has(account.address)) return;

    await ensureResourceAllocation(account);
    const api = await ensureChainReady();
    const reviveTx = api.assetHub as any;

    console.log("[Revive] direct map_account → building tx + asking signer…");
    try {
        await signAndSubmitWithFollowRetry(
            api,
            () => reviveTx.tx.Revive.map_account(),
            account.signer,
            "Revive.map_account",
        );
        _mappedAccounts.add(account.address);
        console.log("[Revive] mapped (direct)");
        return;
    } catch (err) {
        if (isAccountAlreadyMapped(err)) {
            _mappedAccounts.add(account.address);
            console.log("[Revive] already mapped (direct)");
            return;
        }
        console.warn("[Revive] direct map_account failed, trying Utility.batch wrapper:", err);
    }

    try {
        const inner = reviveTx.tx.Revive.map_account().decodedCall;
        await signAndSubmitWithFollowRetry(
            api,
            () => reviveTx.tx.Utility.batch({ calls: [inner] }),
            account.signer,
            "Utility.batch[map_account]",
        );
        _mappedAccounts.add(account.address);
        console.log("[Revive] mapped (via Utility.batch)");
        return;
    } catch (err) {
        if (isAccountAlreadyMapped(err)) {
            _mappedAccounts.add(account.address);
            console.log("[Revive] already mapped (batch)");
            return;
        }
        console.error("[Revive] map_account failed via both paths:", err);
        throw err;
    }
}

// ---------------------------------------------------------------------------
// Bulletin reads via public IPFS gateways (Promise.any race)
// ---------------------------------------------------------------------------

const GATEWAYS = [
    "https://paseo-bulletin-next-ipfs.polkadot.io/ipfs/",
    "https://dweb.link/ipfs/",
    "https://ipfs.io/ipfs/",
    "https://nftstorage.link/ipfs/",
] as const;

export const IPFS_GATEWAY = GATEWAYS[0];

export async function fetchFromGateway(cid: string, timeoutMs = 30000): Promise<Uint8Array> {
    const master = new AbortController();
    const timer = setTimeout(() => master.abort(), timeoutMs);
    try {
        const winner = await Promise.any(
            GATEWAYS.map(async gw => {
                const resp = await fetch(gw + cid, { signal: master.signal });
                if (!resp.ok) throw new Error(`${gw} -> ${resp.status}`);
                return new Uint8Array(await resp.arrayBuffer());
            }),
        );
        master.abort();
        return winner;
    } finally {
        clearTimeout(timer);
    }
}

export async function fetchJsonFromBulletin<T = unknown>(cid: string): Promise<T> {
    const bytes = await fetchFromGateway(cid);
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

export const short = (addr: string) => addr.slice(0, 6) + "..." + addr.slice(-4);

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
        promise,
        new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
        ),
    ]);
}

export const MAX_FEEDBACK_LENGTH = 280;

// Pastel sticky-note palette
const STICKY_PALETTE = [
    "#fff59d", // yellow
    "#f8bbd0", // pink
    "#bbdefb", // blue
    "#c8e6c9", // green
    "#ffe0b2", // orange
    "#d1c4e9", // lavender
];

function hashString(s: string, seed: number): number {
    let h = seed;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return Math.abs(h);
}

export function colorForCid(cid: string): string {
    return STICKY_PALETTE[hashString(cid, 7) % STICKY_PALETTE.length];
}

export function tiltForCid(cid: string): number {
    const h = hashString(cid, 13);
    return ((h % 1000) / 100) - 5;
}

export function formatTime(unixSec: number): string {
    if (!unixSec) return "";
    const d = new Date(unixSec * 1000);
    const diffMs = Date.now() - d.getTime();
    const min = Math.floor(diffMs / 60000);
    if (min < 1) return "just now";
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day}d ago`;
    return d.toLocaleDateString();
}

import { useState, useEffect } from "react";
import {
    useAccountState,
    connectAccount,
    signIn,
    initContracts,
    getContract,
    uploadToBulletin,
    ensureMapping,
    fetchJsonFromBulletin,
    withTimeout,
    short,
    colorForCid,
    tiltForCid,
    formatTime,
    MAX_FEEDBACK_LENGTH,
    type AppAccount,
} from "./utils.ts";
import type { FeedbackData, FeedbackListItem } from "./types.ts";

// CDM init — fails gracefully if cdm.json hasn't been generated yet
try {
    // @ts-ignore — cdm.json is created/updated by `cdm install`
    const cdmJson = await import("../cdm.json");
    await initContracts(cdmJson.default ?? cdmJson);
} catch {
    console.warn("[CDM] cdm.json not found — contract features disabled until deploy");
}

const fb = getContract();

// ---------------------------------------------------------------------------

export default function App() {
    const { status, account, error } = useAccountState();
    const [refreshKey, setRefreshKey] = useState(0);
    const refresh = () => setRefreshKey(k => k + 1);

    useEffect(() => {
        connectAccount();
    }, []);

    if (status === "connecting" || status === "idle") {
        return <div className="spinner">Requesting product account from host...</div>;
    }

    if (status === "signed-out") {
        return (
            <div className="empty">
                <div>Sign in to your Polkadot host to use the feedback board.</div>
                <button className="btn btn-primary" onClick={() => signIn()} style={{ marginTop: 12 }}>
                    Sign in
                </button>
            </div>
        );
    }

    if (status === "error" || !account) {
        return (
            <div className="empty">
                <div>Failed to connect: {error ?? "no account"}</div>
                <button className="btn btn-primary" onClick={() => connectAccount()} style={{ marginTop: 12 }}>
                    Retry
                </button>
            </div>
        );
    }

    return (
        <>
            <header>
                <h1>Feedback Board</h1>
                <span className="account-select" title={account.address}>
                    {account.name ?? short(account.address)}
                </span>
            </header>

            <FeedbackBoard key={refreshKey} />

            <CreateFeedback account={account} onCreated={refresh} />
        </>
    );
}

// ---------------------------------------------------------------------------
// Feedback Board — sticky notes pinned to a cork board
// ---------------------------------------------------------------------------

function FeedbackBoard() {
    const [notes, setNotes] = useState<FeedbackListItem[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const countRes = await fb.getFeedbackCount.query();
                if (!countRes.success || cancelled) return;
                const count = Number(countRes.value);

                const items: FeedbackListItem[] = [];
                for (let i = count - 1; i >= 0; i--) {
                    if (cancelled) return;
                    const [cidRes, creatorRes] = await Promise.all([
                        fb.getFeedbackCid.query(BigInt(i)),
                        fb.getFeedbackCreator.query(BigInt(i)),
                    ]);

                    const cid = cidRes.success ? cidRes.value : "";
                    const creator = creatorRes.success ? String(creatorRes.value) : "";

                    const item: FeedbackListItem = { id: i, cid, creator };

                    if (cid) {
                        try {
                            item.data = await fetchJsonFromBulletin<FeedbackData>(cid);
                        } catch { /* gateway might be slow / cid not yet propagated */ }
                    }

                    items.push(item);
                }

                if (!cancelled) setNotes(items);
            } catch (err) {
                console.error("Failed to load feedback:", err);
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    if (loading) return <div className="spinner">Loading the board...</div>;
    if (notes.length === 0) {
        return (
            <div className="board board-empty">
                <div className="empty">
                    The board is empty.<br />Pin the first note!
                </div>
            </div>
        );
    }

    return (
        <div className="board">
            {notes.map(n => (
                <StickyNote key={n.id} note={n} />
            ))}
        </div>
    );
}

function StickyNote({ note }: { note: FeedbackListItem }) {
    const cid = note.cid || String(note.id);
    const color = colorForCid(cid);
    const tilt = tiltForCid(cid);

    const content = note.data?.content ?? "(content unavailable)";
    const author = note.data?.authorName?.trim() || "anon";
    const time = note.data?.postedAt ? formatTime(note.data.postedAt) : "";

    return (
        <div
            className="sticky"
            style={{
                background: color,
                transform: `rotate(${tilt}deg)`,
            }}
        >
            <div className="pin" />
            <div className="sticky-content">{content}</div>
            <div className="sticky-footer">
                <span className="sticky-author">— {author}</span>
                {time && <span className="sticky-time">{time}</span>}
            </div>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Create Feedback — FAB + modal
// ---------------------------------------------------------------------------

function CreateFeedback({ account, onCreated }: {
    account: AppAccount;
    onCreated: () => void;
}) {
    const [open, setOpen] = useState(false);
    const [content, setContent] = useState("");
    const [authorName, setAuthorName] = useState("");
    const [statusMsg, setStatusMsg] = useState("");
    const [busy, setBusy] = useState(false);

    const reset = () => {
        setContent("");
        setAuthorName("");
        setStatusMsg("");
    };

    const remaining = MAX_FEEDBACK_LENGTH - content.length;
    const isValid = content.trim().length > 0 && authorName.trim().length > 0 && remaining >= 0;

    const submit = async () => {
        if (!isValid || busy) return;
        setBusy(true);
        try {
            const feedbackData: FeedbackData = {
                content: content.trim(),
                authorName: authorName.trim(),
                postedAt: Math.floor(Date.now() / 1000),
            };

            setStatusMsg("Uploading note to Bulletin...");
            const bytes = new TextEncoder().encode(JSON.stringify(feedbackData));
            const cid = await uploadToBulletin(account, bytes);

            setStatusMsg("Mapping account (first time only)...");
            await ensureMapping(account);

            setStatusMsg("Pinning to the board...");
            await withTimeout(
                fb.postFeedback.tx(
                    cid,
                    { signer: account.getSigner(), origin: account.address },
                ),
                120_000,
                "postFeedback.tx",
            );

            reset();
            setOpen(false);
            onCreated();
        } catch (err) {
            console.error("Post feedback error:", err);
            setStatusMsg("Failed — check console");
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <button className="fab" onClick={() => setOpen(true)} aria-label="New note">+</button>
            {open && (
                <div className="modal-overlay" onClick={() => !busy && setOpen(false)}>
                    <div className="modal" onClick={e => e.stopPropagation()}>
                        <h2>New sticky note</h2>

                        <input
                            type="text"
                            placeholder="Your name"
                            value={authorName}
                            onChange={e => setAuthorName(e.target.value.slice(0, 40))}
                            disabled={busy}
                        />

                        <textarea
                            rows={5}
                            placeholder="What do you think? (max 280 chars)"
                            value={content}
                            onChange={e => setContent(e.target.value.slice(0, MAX_FEEDBACK_LENGTH))}
                            disabled={busy}
                        />

                        <div className={`char-counter ${remaining < 20 ? "low" : ""}`}>
                            {remaining} characters left
                        </div>

                        {statusMsg && <div className="status">{statusMsg}</div>}

                        <div className="modal-actions">
                            <button
                                className="btn btn-ghost"
                                onClick={() => { reset(); setOpen(false); }}
                                disabled={busy}
                            >
                                Cancel
                            </button>
                            <button
                                className="btn btn-primary"
                                onClick={submit}
                                disabled={busy || !isValid}
                            >
                                {busy ? "Posting..." : "Pin to board"}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}

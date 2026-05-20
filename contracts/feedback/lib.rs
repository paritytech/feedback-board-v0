#![no_main]
#![no_std]

use alloc::string::String;
use pvm::storage::Mapping;
use pvm_contract as pvm;

#[allow(unreachable_code)]
fn revert(msg: &[u8]) -> ! {
    pvm::api::return_value(pvm_contract::ReturnFlags::REVERT, msg);
    loop {}
}

#[pvm::storage]
struct Storage {
    feedback_count: u64,
    feedback_cids: Mapping<u64, String>,
    feedback_creators: Mapping<u64, [u8; 20]>,
}

#[pvm::contract(cdm = "@example/feedback")]
mod feedback {
    use super::*;

    #[pvm::constructor]
    pub fn new() -> Result<(), Error> {
        Storage::feedback_count().set(&0);
        Ok(())
    }

    #[pvm::method]
    pub fn post_feedback(cid: String) -> u64 {
        let caller = *pvm::caller().as_fixed_bytes();
        let id = Storage::feedback_count().get().unwrap_or(0);

        Storage::feedback_cids().insert(&id, &cid);
        Storage::feedback_creators().insert(&id, &caller);
        Storage::feedback_count().set(&(id + 1));

        id
    }

    #[pvm::method]
    pub fn get_feedback_count() -> u64 {
        Storage::feedback_count().get().unwrap_or(0)
    }

    #[pvm::method]
    pub fn get_feedback_cid(id: u64) -> String {
        match Storage::feedback_cids().get(&id) {
            Some(cid) => cid,
            None => revert(b"FeedbackNotFound"),
        }
    }

    #[pvm::method]
    pub fn get_feedback_creator(id: u64) -> [u8; 20] {
        match Storage::feedback_creators().get(&id) {
            Some(addr) => addr,
            None => revert(b"FeedbackNotFound"),
        }
    }
}

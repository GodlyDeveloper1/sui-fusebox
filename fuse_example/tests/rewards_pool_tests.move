#[test_only]
module fuse_example::rewards_pool_tests;

use fuse::fuse;
use fuse_example::rewards_pool::{Self, AdminCap, Pool};
use sui::coin;
use sui::sui::SUI;
use sui::test_scenario::{Self as ts, Scenario};

const TEAM: address = @0x7EA;
const ALICE: address = @0xA11CE;
const ATTACKER: address = @0xBAD;

const POOL_SIZE: u64 = 150_000;

/// A pool funded with 150,000 SUI units, where Alice has earned 10,000 points.
fun setup(): Scenario {
    let mut scenario = ts::begin(TEAM);
    rewards_pool::init_for_testing(scenario.ctx());
    scenario.next_tx(TEAM);
    let mut pool = scenario.take_shared<Pool>();
    let cap = scenario.take_from_sender<AdminCap>();
    pool.fund(&cap, coin::mint_for_testing<SUI>(POOL_SIZE, scenario.ctx()), scenario.ctx());
    pool.credit(&cap, ALICE, 10_000, scenario.ctx());
    ts::return_shared(pool);
    scenario.return_to_sender(cap);
    scenario
}

#[test]
fun an_honest_user_redeems_what_they_earned() {
    let mut scenario = setup();
    scenario.next_tx(ALICE);
    let mut pool = scenario.take_shared<Pool>();
    let paid = pool.redeem(10_000, scenario.ctx());
    assert!(paid.value() == 10_000);
    assert!(pool.balance() == POOL_SIZE - 10_000);
    paid.burn_for_testing();
    ts::return_shared(pool);
    scenario.end();
}

/// The exploit: mint yourself more points than the pool holds, then redeem.
/// It never gets as far as the redeem.
#[test, expected_failure(abort_code = fuse::EInsolvent)]
fun the_points_exploit_aborts() {
    let mut scenario = setup();
    scenario.next_tx(ATTACKER);
    let mut pool = scenario.take_shared<Pool>();
    pool.update_points(162_000_000_000_000, scenario.ctx());
    abort
}

/// A careful attacker mints only what the pool can cover, so the pool stays
/// solvent on paper. The per-transaction limit stops the drain.
#[test, expected_failure(abort_code = fuse::ETxOutflow)]
fun a_solvent_looking_drain_hits_the_transaction_limit() {
    let mut scenario = setup();
    scenario.next_tx(ATTACKER);
    let mut pool = scenario.take_shared<Pool>();
    pool.update_points(140_000, scenario.ctx());
    let _stolen = pool.redeem(140_000, scenario.ctx());
    abort
}

/// The same attacker splits the drain across transactions, each one under the
/// per-transaction limit. The per-epoch limit stops it.
#[test, expected_failure(abort_code = fuse::EEpochOutflow)]
fun a_slow_drain_hits_the_epoch_limit() {
    let mut scenario = setup();
    scenario.next_epoch(ATTACKER);
    let mut pool = scenario.take_shared<Pool>();
    pool.update_points(140_000, scenario.ctx());
    ts::return_shared(pool);

    // Each 15,000 is under the 20% transaction limit. The fifth one would
    // take the epoch's total past 40%.
    5u64.do!(|_| {
        scenario.next_tx(ATTACKER);
        let mut pool = scenario.take_shared<Pool>();
        pool.redeem(15_000, scenario.ctx()).burn_for_testing();
        ts::return_shared(pool);
    });
    abort
}

/// What the slow drain actually gets before the fuse blows: at most 40% of
/// the pool, not all of it.
#[test]
fun the_slow_drain_is_capped_at_the_epoch_limit() {
    let mut scenario = setup();
    scenario.next_epoch(ATTACKER);
    let mut pool = scenario.take_shared<Pool>();
    pool.update_points(140_000, scenario.ctx());
    ts::return_shared(pool);

    // Four transactions of 15,000 are allowed: 60,000 is exactly 40%.
    4u64.do!(|_| {
        scenario.next_tx(ATTACKER);
        let mut pool = scenario.take_shared<Pool>();
        pool.redeem(15_000, scenario.ctx()).burn_for_testing();
        ts::return_shared(pool);
    });
    scenario.next_tx(TEAM);
    let pool = scenario.take_shared<Pool>();
    assert!(pool.balance() == POOL_SIZE - 60_000);
    ts::return_shared(pool);
    scenario.end();
}

/// Once the team sees it, pausing stops everything.
#[test, expected_failure(abort_code = fuse::EPaused)]
fun pausing_stops_all_movement() {
    let mut scenario = setup();
    scenario.next_tx(TEAM);
    let mut pool = scenario.take_shared<Pool>();
    let cap = scenario.take_from_sender<AdminCap>();
    pool.pause(&cap);
    ts::return_shared(pool);
    scenario.return_to_sender(cap);

    scenario.next_tx(ALICE);
    let mut pool = scenario.take_shared<Pool>();
    let _paid = pool.redeem(10_000, scenario.ctx());
    abort
}

/// A flash loan of most of the pool passes, because the ticket is settled
/// only after the money is back.
#[test]
fun a_flash_loan_that_is_repaid_passes() {
    let mut scenario = setup();
    scenario.next_tx(ALICE);
    let mut pool = scenario.take_shared<Pool>();
    let (borrowed, ticket) = pool.flash_borrow(120_000, scenario.ctx());
    pool.flash_repay(borrowed, ticket);
    assert!(pool.balance() == POOL_SIZE);
    ts::return_shared(pool);
    scenario.end();
}

/// A flash loan repaid short does not pass. The pool could still cover
/// Alice's 10,000 points, so it is the transaction limit that catches it.
#[test, expected_failure(abort_code = fuse::ETxOutflow)]
fun a_flash_loan_repaid_short_aborts() {
    let mut scenario = setup();
    scenario.next_tx(ATTACKER);
    let mut pool = scenario.take_shared<Pool>();
    let (mut borrowed, ticket) = pool.flash_borrow(120_000, scenario.ctx());
    let _kept = borrowed.split(100_000, scenario.ctx());
    pool.flash_repay(borrowed, ticket);
    abort
}

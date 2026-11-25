#[test_only]
module fuse::fuse_tests;

use fuse::fuse::{Self, Vault};
use sui::balance;
use sui::sui::SUI;
use sui::test_scenario as ts;

const ADMIN: address = @0xA;

/// A vault with 1000 SUI units in it, exactly backed by 1000 of claims.
fun funded(tx_bps: u64, epoch_bps: u64, ctx: &mut TxContext): Vault<SUI> {
    let mut vault = fuse::new<SUI>(fuse::new_rules(tx_bps, epoch_bps), ctx);
    let ticket = fuse::open(&mut vault, ctx);
    fuse::deposit(&mut vault, &ticket, balance::create_for_testing(1000));
    fuse::add_claims(&mut vault, &ticket, 1000);
    fuse::settle(&vault, ticket);
    vault
}

/// Pay out `amount` against claims, the honest way.
fun redeem(vault: &mut Vault<SUI>, amount: u64, ctx: &TxContext) {
    let ticket = fuse::open(vault, ctx);
    fuse::remove_claims(vault, &ticket, amount);
    fuse::withdraw(vault, &ticket, amount).destroy_for_testing();
    fuse::settle(vault, ticket);
}

fun burn(vault: Vault<SUI>) {
    std::unit_test::destroy(vault);
}

#[test]
fun honest_redeem_within_limits_passes() {
    let mut scenario = ts::begin(ADMIN);
    let mut vault = funded(2000, 5000, scenario.ctx());
    scenario.next_tx(ADMIN);
    redeem(&mut vault, 200, scenario.ctx());
    assert!(vault.balance() == 800);
    assert!(vault.claims() == 800);
    assert!(vault.surplus() == 0);
    burn(vault);
    scenario.end();
}

#[test, expected_failure(abort_code = fuse::EInsolvent)]
fun claims_created_from_nothing_abort() {
    let mut scenario = ts::begin(ADMIN);
    let mut vault = funded(10_000, 10_000, scenario.ctx());
    scenario.next_tx(ADMIN);
    let ticket = fuse::open(&mut vault, scenario.ctx());
    fuse::add_claims(&mut vault, &ticket, 1);
    fuse::settle(&vault, ticket);
    abort
}

#[test, expected_failure(abort_code = fuse::EInsolvent)]
fun withdrawal_without_burning_claims_aborts() {
    let mut scenario = ts::begin(ADMIN);
    let mut vault = funded(10_000, 10_000, scenario.ctx());
    scenario.next_tx(ADMIN);
    let ticket = fuse::open(&mut vault, scenario.ctx());
    fuse::withdraw(&mut vault, &ticket, 1).destroy_for_testing();
    fuse::settle(&vault, ticket);
    abort
}

#[test, expected_failure(abort_code = fuse::ETxOutflow)]
fun one_transaction_over_the_tx_limit_aborts() {
    let mut scenario = ts::begin(ADMIN);
    let mut vault = funded(2000, 10_000, scenario.ctx());
    scenario.next_tx(ADMIN);
    redeem(&mut vault, 201, scenario.ctx());
    abort
}

#[test, expected_failure(abort_code = fuse::ETxOutflow)]
fun splitting_into_many_tickets_in_one_transaction_does_not_dodge_the_tx_limit() {
    let mut scenario = ts::begin(ADMIN);
    let mut vault = funded(2000, 10_000, scenario.ctx());
    scenario.next_tx(ADMIN);
    redeem(&mut vault, 150, scenario.ctx());
    redeem(&mut vault, 150, scenario.ctx());
    abort
}

#[test, expected_failure(abort_code = fuse::EEpochOutflow)]
fun splitting_into_many_transactions_hits_the_epoch_limit() {
    let mut scenario = ts::begin(ADMIN);
    let mut vault = funded(5000, 3000, scenario.ctx());
    // The vault was created and funded in epoch 0, so move on one epoch to
    // make 1000 the starting balance the epoch limit is measured from.
    scenario.next_epoch(ADMIN);
    redeem(&mut vault, 150, scenario.ctx());
    scenario.next_tx(ADMIN);
    redeem(&mut vault, 150, scenario.ctx());
    scenario.next_tx(ADMIN);
    redeem(&mut vault, 150, scenario.ctx());
    abort
}

#[test]
fun a_new_epoch_resets_the_epoch_limit() {
    let mut scenario = ts::begin(ADMIN);
    let mut vault = funded(5000, 3000, scenario.ctx());
    scenario.next_epoch(ADMIN);
    redeem(&mut vault, 150, scenario.ctx());
    scenario.next_tx(ADMIN);
    redeem(&mut vault, 150, scenario.ctx());
    scenario.next_epoch(ADMIN);
    redeem(&mut vault, 150, scenario.ctx());
    assert!(vault.balance() == 550);
    burn(vault);
    scenario.end();
}

#[test]
fun taking_and_returning_inside_one_ticket_passes() {
    let mut scenario = ts::begin(ADMIN);
    let mut vault = funded(0, 0, scenario.ctx());
    scenario.next_tx(ADMIN);
    // Limits are zero, yet a flash-style take and return is fine because the
    // rules are only checked at settle.
    let ticket = fuse::open(&mut vault, scenario.ctx());
    let borrowed = fuse::withdraw(&mut vault, &ticket, 900);
    fuse::deposit(&mut vault, &ticket, borrowed);
    fuse::settle(&vault, ticket);
    burn(vault);
    scenario.end();
}

#[test]
fun a_loan_is_backed_by_a_receivable() {
    let mut scenario = ts::begin(ADMIN);
    let mut vault = funded(5000, 5000, scenario.ctx());
    scenario.next_tx(ADMIN);
    let ticket = fuse::open(&mut vault, scenario.ctx());
    fuse::withdraw(&mut vault, &ticket, 400).destroy_for_testing();
    fuse::add_receivable(&mut vault, &ticket, 400);
    fuse::settle(&vault, ticket);
    assert!(vault.balance() == 600);
    assert!(vault.receivables() == 400);
    burn(vault);
    scenario.end();
}

#[test, expected_failure(abort_code = fuse::EPaused)]
fun a_paused_vault_cannot_be_touched() {
    let mut scenario = ts::begin(ADMIN);
    let mut vault = funded(10_000, 10_000, scenario.ctx());
    fuse::set_paused(&mut vault, true);
    scenario.next_tx(ADMIN);
    let _ticket = fuse::open(&mut vault, scenario.ctx());
    abort
}

#[test, expected_failure(abort_code = fuse::EWrongVault)]
fun a_ticket_from_another_vault_is_rejected() {
    let mut scenario = ts::begin(ADMIN);
    let mut victim = funded(10_000, 10_000, scenario.ctx());
    let mut decoy = fuse::new<SUI>(fuse::new_rules(10_000, 10_000), scenario.ctx());
    scenario.next_tx(ADMIN);
    let ticket = fuse::open(&mut decoy, scenario.ctx());
    fuse::withdraw(&mut victim, &ticket, 1000).destroy_for_testing();
    abort
}

#[test, expected_failure(abort_code = fuse::EBadRules)]
fun limits_above_100_percent_are_rejected() {
    fuse::new_rules(10_001, 0);
}

#[test]
fun an_empty_vault_can_be_destroyed() {
    let mut scenario = ts::begin(ADMIN);
    let vault = fuse::new<SUI>(fuse::new_rules(0, 0), scenario.ctx());
    vault.destroy_empty();
    scenario.end();
}

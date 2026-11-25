/// Fuse: custody with invariants that cannot be skipped.
///
/// A protocol keeps its funds in a `Vault<T>` instead of a bare `Balance<T>`.
/// Every operation that changes the vault needs a `Ticket`. A `Ticket` is a
/// "hot potato": it has no abilities, so it cannot be stored, copied or
/// dropped. The only way to get rid of one is `settle`, and `settle` checks
/// the vault's rules. If a rule is broken the whole transaction aborts and
/// nothing moves.
///
/// The rules checked at `settle`:
///   1. Solvency      balance + receivables >= claims
///   2. Tx floor      one transaction cannot take the balance below
///                    (100% - max_tx_outflow) of where the transaction found it
///   3. Epoch floor   the same, measured from the first touch of the epoch
///
/// A protocol can settle inside its own function (rules hold when the function
/// returns) or hand the ticket back to the caller (rules hold when the whole
/// programmable transaction ends, which allows flash-style composition).
module fuse::fuse;

use sui::balance::{Self, Balance};
use sui::event;

/// Basis points in 100%.
const BPS: u64 = 10_000;

#[error]
const EWrongVault: vector<u8> = b"This ticket was opened on a different vault";
#[error]
const EPaused: vector<u8> = b"The vault is paused";
#[error]
const EInsolvent: vector<u8> = b"Claims exceed the assets backing them";
#[error]
const ETxOutflow: vector<u8> = b"This transaction takes out more than the per-transaction limit";
#[error]
const EEpochOutflow: vector<u8> = b"Outflow this epoch is over the per-epoch limit";
#[error]
const EBadRules: vector<u8> = b"Limits are in basis points and cannot exceed 10000";
#[error]
const EClaimsUnderflow: vector<u8> = b"Cannot remove more claims than exist";
#[error]
const EReceivablesUnderflow: vector<u8> = b"Cannot remove more receivables than exist";
#[error]
const ENotEmpty: vector<u8> = b"The vault still holds assets, claims or receivables";

/// Limits for a vault. 10000 means "no limit", 0 means "no net outflow at all".
public struct Rules has copy, drop, store {
    /// Largest share of the balance one transaction may remove, in basis points.
    max_tx_outflow_bps: u64,
    /// Largest share of the balance that may leave within one epoch, in basis points.
    max_epoch_outflow_bps: u64,
}

/// Guarded custody of `Balance<T>`. Embed it in the protocol's own object.
/// Only the module that owns that object can reach it, so holding a
/// `&mut Vault` is the permission to operate it.
public struct Vault<phantom T> has store {
    id: ID,
    balance: Balance<T>,
    /// What the protocol owes its users, in units of `T`.
    claims: u128,
    /// Assets owed back to the vault and held elsewhere (for example loans).
    receivables: u128,
    rules: Rules,
    paused: bool,
    /// Digest of the transaction that last opened a ticket.
    tx_digest: vector<u8>,
    /// Balance when that transaction first touched the vault.
    tx_start_balance: u64,
    /// Epoch that last opened a ticket.
    epoch: u64,
    /// Balance when that epoch first touched the vault.
    epoch_start_balance: u64,
}

/// Hot potato. No abilities: it must be passed to `settle` before the
/// transaction ends.
public struct Ticket {
    vault: ID,
}

public struct RulesChanged has copy, drop {
    vault: ID,
    max_tx_outflow_bps: u64,
    max_epoch_outflow_bps: u64,
}

public struct PauseChanged has copy, drop {
    vault: ID,
    paused: bool,
}

// === Setup ===

public fun new_rules(max_tx_outflow_bps: u64, max_epoch_outflow_bps: u64): Rules {
    assert!(max_tx_outflow_bps <= BPS && max_epoch_outflow_bps <= BPS, EBadRules);
    Rules { max_tx_outflow_bps, max_epoch_outflow_bps }
}

public fun new<T>(rules: Rules, ctx: &mut TxContext): Vault<T> {
    Vault {
        id: object::id_from_address(ctx.fresh_object_address()),
        balance: balance::zero(),
        claims: 0,
        receivables: 0,
        rules,
        paused: false,
        tx_digest: vector[],
        tx_start_balance: 0,
        epoch: ctx.epoch(),
        epoch_start_balance: 0,
    }
}

/// Destroy a vault that holds nothing and owes nothing.
public fun destroy_empty<T>(vault: Vault<T>) {
    let Vault { balance, claims, receivables, .. } = vault;
    assert!(balance.value() == 0 && claims == 0 && receivables == 0, ENotEmpty);
    balance.destroy_zero();
}

// === Ticket lifecycle ===

/// Start a guarded section. Records where this transaction and this epoch
/// found the balance, the first time each one touches the vault.
public fun open<T>(vault: &mut Vault<T>, ctx: &TxContext): Ticket {
    assert!(!vault.paused, EPaused);
    let balance = vault.balance.value();
    if (vault.tx_digest != *ctx.digest()) {
        vault.tx_digest = *ctx.digest();
        vault.tx_start_balance = balance;
    };
    if (vault.epoch != ctx.epoch()) {
        vault.epoch = ctx.epoch();
        vault.epoch_start_balance = balance;
    };
    Ticket { vault: vault.id }
}

/// End a guarded section. Aborts the transaction if any rule is broken.
public fun settle<T>(vault: &Vault<T>, ticket: Ticket) {
    let Ticket { vault: id } = ticket;
    assert!(id == vault.id, EWrongVault);
    let balance = vault.balance.value();
    assert!((balance as u128) + vault.receivables >= vault.claims, EInsolvent);
    assert!(above_floor(balance, vault.tx_start_balance, vault.rules.max_tx_outflow_bps), ETxOutflow);
    assert!(
        above_floor(balance, vault.epoch_start_balance, vault.rules.max_epoch_outflow_bps),
        EEpochOutflow,
    );
}

/// True when `balance` has not dropped below `start` by more than `max_bps`.
fun above_floor(balance: u64, start: u64, max_bps: u64): bool {
    (balance as u128) * (BPS as u128) >= (start as u128) * ((BPS - max_bps) as u128)
}

// === Guarded operations ===

public fun deposit<T>(vault: &mut Vault<T>, ticket: &Ticket, funds: Balance<T>) {
    assert!(ticket.vault == vault.id, EWrongVault);
    vault.balance.join(funds);
}

public fun withdraw<T>(vault: &mut Vault<T>, ticket: &Ticket, amount: u64): Balance<T> {
    assert!(ticket.vault == vault.id, EWrongVault);
    vault.balance.split(amount)
}

/// Record that the protocol now owes `amount` more to its users.
public fun add_claims<T>(vault: &mut Vault<T>, ticket: &Ticket, amount: u64) {
    assert!(ticket.vault == vault.id, EWrongVault);
    vault.claims = vault.claims + (amount as u128);
}

/// Record that `amount` of what the protocol owed has been paid or cancelled.
public fun remove_claims<T>(vault: &mut Vault<T>, ticket: &Ticket, amount: u64) {
    assert!(ticket.vault == vault.id, EWrongVault);
    assert!(vault.claims >= (amount as u128), EClaimsUnderflow);
    vault.claims = vault.claims - (amount as u128);
}

/// Record assets that left the vault but are owed back to it (a loan).
public fun add_receivable<T>(vault: &mut Vault<T>, ticket: &Ticket, amount: u64) {
    assert!(ticket.vault == vault.id, EWrongVault);
    vault.receivables = vault.receivables + (amount as u128);
}

/// Record that `amount` of what was owed to the vault came back or was written off.
public fun remove_receivable<T>(vault: &mut Vault<T>, ticket: &Ticket, amount: u64) {
    assert!(ticket.vault == vault.id, EWrongVault);
    assert!(vault.receivables >= (amount as u128), EReceivablesUnderflow);
    vault.receivables = vault.receivables - (amount as u128);
}

// === Administration ===
// The protocol decides who may call these by how it exposes its `&mut Vault`.

public fun set_rules<T>(vault: &mut Vault<T>, rules: Rules) {
    vault.rules = rules;
    event::emit(RulesChanged {
        vault: vault.id,
        max_tx_outflow_bps: rules.max_tx_outflow_bps,
        max_epoch_outflow_bps: rules.max_epoch_outflow_bps,
    });
}

/// While paused, no ticket can be opened, so nothing in the vault can change.
public fun set_paused<T>(vault: &mut Vault<T>, paused: bool) {
    vault.paused = paused;
    event::emit(PauseChanged { vault: vault.id, paused });
}

// === Views ===

public fun id<T>(vault: &Vault<T>): ID { vault.id }

public fun balance<T>(vault: &Vault<T>): u64 { vault.balance.value() }

public fun claims<T>(vault: &Vault<T>): u128 { vault.claims }

public fun receivables<T>(vault: &Vault<T>): u128 { vault.receivables }

public fun is_paused<T>(vault: &Vault<T>): bool { vault.paused }

public fun rules<T>(vault: &Vault<T>): Rules { vault.rules }

public fun max_tx_outflow_bps(rules: &Rules): u64 { rules.max_tx_outflow_bps }

public fun max_epoch_outflow_bps(rules: &Rules): u64 { rules.max_epoch_outflow_bps }

/// Assets not owed to anyone. Zero when the vault is exactly backed.
public fun surplus<T>(vault: &Vault<T>): u128 {
    let assets = (vault.balance.value() as u128) + vault.receivables;
    if (assets > vault.claims) assets - vault.claims else 0
}

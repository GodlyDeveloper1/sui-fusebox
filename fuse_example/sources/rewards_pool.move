/// A rewards pool with a real bug in it, to show what Fuse does.
///
/// `update_points` is missing a check: anyone can give themselves any number
/// of points. Points are redeemed 1:1 for SUI, so without Fuse this bug
/// empties the pool in one transaction. With the pool's funds held in a
/// `fuse::Vault`, the exploit transaction aborts instead.
module fuse_example::rewards_pool;

use fuse::fuse::{Self, Ticket, Vault};
use sui::coin::{Self, Coin};
use sui::sui::SUI;
use sui::table::{Self, Table};

#[error]
const ENotEnoughPoints: vector<u8> = b"Not enough points";

public struct Pool has key {
    id: UID,
    vault: Vault<SUI>,
    points: Table<address, u64>,
}

public struct AdminCap has key, store {
    id: UID,
}

fun init(ctx: &mut TxContext) {
    transfer::share_object(Pool {
        id: object::new(ctx),
        // One transaction may take at most 20% of the pool, one epoch at most 40%.
        vault: fuse::new(fuse::new_rules(2000, 4000), ctx),
        points: table::new(ctx),
    });
    transfer::transfer(AdminCap { id: object::new(ctx) }, ctx.sender());
}

/// The team tops up the pool. Assets go up, nothing is owed yet.
public fun fund(pool: &mut Pool, _: &AdminCap, coin: Coin<SUI>, ctx: &TxContext) {
    let ticket = fuse::open(&mut pool.vault, ctx);
    fuse::deposit(&mut pool.vault, &ticket, coin.into_balance());
    fuse::settle(&pool.vault, ticket);
}

/// The honest path: the team credits a user with points they earned.
public fun credit(pool: &mut Pool, _: &AdminCap, user: address, amount: u64, ctx: &TxContext) {
    add_points(pool, user, amount, ctx);
}

/// THE BUG. This was meant to recompute the caller's points from their
/// stake, but the validation is missing, so the caller picks the number.
public fun update_points(pool: &mut Pool, amount: u64, ctx: &TxContext) {
    add_points(pool, ctx.sender(), amount, ctx);
}

/// Swap points for SUI, 1:1.
public fun redeem(pool: &mut Pool, amount: u64, ctx: &mut TxContext): Coin<SUI> {
    let sender = ctx.sender();
    assert!(
        pool.points.contains(sender) && pool.points[sender] >= amount,
        ENotEnoughPoints,
    );
    let owned = &mut pool.points[sender];
    *owned = *owned - amount;

    let ticket = fuse::open(&mut pool.vault, ctx);
    fuse::remove_claims(&mut pool.vault, &ticket, amount);
    let paid = fuse::withdraw(&mut pool.vault, &ticket, amount);
    fuse::settle(&pool.vault, ticket);
    coin::from_balance(paid, ctx)
}

/// Flash loan: the ticket is handed to the caller, so the rules are checked
/// when the caller's whole transaction ends, not when this function returns.
public fun flash_borrow(pool: &mut Pool, amount: u64, ctx: &mut TxContext): (Coin<SUI>, Ticket) {
    let ticket = fuse::open(&mut pool.vault, ctx);
    let lent = fuse::withdraw(&mut pool.vault, &ticket, amount);
    (coin::from_balance(lent, ctx), ticket)
}

/// The only way to get rid of the ticket from `flash_borrow`.
public fun flash_repay(pool: &mut Pool, coin: Coin<SUI>, ticket: Ticket) {
    fuse::deposit(&mut pool.vault, &ticket, coin.into_balance());
    fuse::settle(&pool.vault, ticket);
}

public fun pause(pool: &mut Pool, _: &AdminCap) {
    fuse::set_paused(&mut pool.vault, true);
}

public fun points_of(pool: &Pool, user: address): u64 {
    if (pool.points.contains(user)) pool.points[user] else 0
}

public fun balance(pool: &Pool): u64 { pool.vault.balance() }

fun add_points(pool: &mut Pool, user: address, amount: u64, ctx: &TxContext) {
    if (!pool.points.contains(user)) pool.points.add(user, 0);
    let owned = &mut pool.points[user];
    *owned = *owned + amount;

    let ticket = fuse::open(&mut pool.vault, ctx);
    fuse::add_claims(&mut pool.vault, &ticket, amount);
    fuse::settle(&pool.vault, ticket);
}

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) { init(ctx) }

/// Test fixture, version 2: the upgrade of v1.
module legacy_pool::pool;

use legacy_pool::guard;
use sui::balance::Balance;
use sui::coin::{Self, Coin};
use sui::sui::SUI;

public struct Pool has key {
    id: UID,
    funds: Balance<SUI>,
    version: u64,
    rate: u64,
    paid_out: u64,
}

public struct AdminCap has key, store {
    id: UID,
}

#[error]
const ETooMuch: vector<u8> = b"Claim is larger than the pool allows";

/// Fixed: the payout is now capped. Still no version check, so the v1 body
/// stays callable.
public fun claim(pool: &mut Pool, points: u64, ctx: &mut TxContext): Coin<SUI> {
    let amount = points * pool.rate;
    assert!(amount <= pool.funds.value() / 10, ETooMuch);
    pool.paid_out = pool.paid_out + amount;
    coin::from_balance(pool.funds.split(amount), ctx)
}

/// Changed, and version checked.
public fun deposit(pool: &mut Pool, coin: Coin<SUI>) {
    guard::check(pool.version);
    pool.paid_out = 0;
    pool.funds.join(coin.into_balance());
}

/// Changed, admin only.
public fun set_rate(pool: &mut Pool, _: &AdminCap, rate: u64) {
    pool.rate = if (rate > 100) 100 else rate;
}

/// Identical to v1.
public fun touch(pool: &mut Pool) {
    pool.paid_out = pool.paid_out + 0;
}

public fun funds(pool: &Pool): u64 { pool.funds.value() }

public(package) fun internal_reset(pool: &mut Pool) {
    pool.paid_out = 0;
}

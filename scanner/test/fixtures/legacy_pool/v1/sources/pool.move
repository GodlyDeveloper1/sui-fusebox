/// Test fixture, version 1 of a package that is later upgraded.
/// It contains every pattern the scanner has to tell apart.
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

/// No version check. The payout maths is wrong and gets fixed in v2.
public fun claim(pool: &mut Pool, points: u64, ctx: &mut TxContext): Coin<SUI> {
    let amount = points * pool.rate;
    pool.paid_out = pool.paid_out + amount;
    coin::from_balance(pool.funds.split(amount), ctx)
}

/// Version checked through a helper in another module.
public fun deposit(pool: &mut Pool, coin: Coin<SUI>) {
    guard::check(pool.version);
    pool.funds.join(coin.into_balance());
}

/// No version check, but only the admin can call it.
public fun set_rate(pool: &mut Pool, _: &AdminCap, rate: u64) {
    pool.rate = rate;
}

/// No version check, and never changed by the upgrade.
public fun touch(pool: &mut Pool) {
    pool.paid_out = pool.paid_out + 0;
}

/// Private entry function with no version check. Removed in v2.
entry fun legacy_sweep(pool: &mut Pool, ctx: &mut TxContext) {
    let all = pool.funds.value();
    transfer::public_transfer(coin::from_balance(pool.funds.split(all), ctx), ctx.sender());
}

/// Read only: cannot change anything, so it is never reported.
public fun funds(pool: &Pool): u64 { pool.funds.value() }

/// Not callable from outside the package, so it is never reported.
public(package) fun internal_reset(pool: &mut Pool) {
    pool.paid_out = 0;
}

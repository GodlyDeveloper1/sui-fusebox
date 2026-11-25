# Legacy code report

- **Package:** `0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb`
- **Latest version:** v15 at `0x260693ec785a6e6c9d81d58c7d2ff72f1288ae0fa6a9725abe05a6478b11f084`
- **Versions scanned:** 15

No stale code that can pay coins out is open to the public. 1 old function can still change protocol state with outdated rules.

| Severity | Function | Drift | Can modify | Callable in |
| --- | --- | --- | --- | --- |
| medium | `partner::receive_ref_fee` | disabled | `partner::Partner` | v1, v2, v3, v4, v5, v6, v7, v8, v9, v10, v11, v12 |
| low | `pool::update_pool` | disabled | `pool::Pool` | v7 |

## MEDIUM: `partner::receive_ref_fee`

```move
public fun receive_ref_fee(&mut partner::Partner, 0x2::balance::Balance<T0>)
```

Anyone can call this older copy, it has no version check, and the logic was disabled in the latest version. It has no path that takes coins out, so it cannot drain funds by itself, but it can change protocol state with outdated rules.

- v1: `0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb`
- v2: `0xbd6d0f475ccdfd81ed148d70a2f84883d8c63f332d046215bd0ccf528290358e`
- v3: `0xfa36bcb799278bddaf295991b2d3ce039013b1dd60dfd7183dee135fdadbc4be`
- v4: `0xcfffc9eef305baa854565a229c719c07d1e6b8b67ce444995e21580fc1866919`
- v5: `0xc33c3e937e5aa2009cc0c3fdb3f345a0c3193d4ee663ffc601fe8b894fbc4ba6`
- v6: `0x70968826ad1b4ba895753f634b0aea68d0672908ca1075a2abdf0fc9e0b2fc6a`
- v7: `0x2b1e8820da53ff881de69f85c7c8c4f75c9b4bdd2a738b635b43559115a2bea4`
- v8: `0x157468379cfe5616c063ae39a889dd184ad48350d3e08f8d9b4ade22b8e3fb61`
- v9: `0xdc67d6de3f00051c505da10d8f6fbab3b3ec21ec65f0dc22a2f36c13fc102110`
- v10: `0xc6faf3703b0e8ba9ed06b7851134bbbe7565eb35ff823fd78432baa4cbeaa12e`
- v11: `0x687e4b27fd88de55f2d7023dc7a3ec07ccd28b6a45a35ac88e95b6c387a3e338`
- v12: `0x75b2e9ecad34944b8d0c874e568c90db0cf9437f0d7392abfd4cb902972f3e40`

## LOW: `pool::update_pool`

```move
public fun update_pool(&config::GlobalConfig, &mut pool::Pool<T0, T1>, 0x2::coin::Coin<T0>, 0x2::coin::Coin<T1>, &0x2::tx_context::TxContext)
```

No version check and the logic was disabled in the latest version, but calling it needs a role the caller is checked against.

- v7: `0x2b1e8820da53ff881de69f85c7c8c4f75c9b4bdd2a738b635b43559115a2bea4`

_Version checks are detected by pattern (a `version` field, a version-named call, a `Version` object). A function reported here may still be safe for a reason the scanner cannot see, and a HIGH finding is a lead to review, not proof of an exploit._

module legacy_pool::guard;

const VERSION: u64 = 1;

#[error]
const EWrongVersion: vector<u8> = b"This package version is no longer supported";

public(package) fun check(version: u64) {
    assert!(version == VERSION, EWrongVersion);
}

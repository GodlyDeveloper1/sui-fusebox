# legacy_pool fixture

Two versions of one small package, used by the scanner's tests.

- `v1/` and `v2/` are the Move sources. `v2` is what an upgrade of `v1` would publish.
- `bytecode/` holds the compiled modules the tests read, so the tests do not need the Sui CLI.
- `bytecode/v1_shifted/` is `v1` compiled with extra comment lines at the top of each file. Its logic is identical; only the line numbers embedded in abort codes differ.

To rebuild after editing a source file, run `sui move build` in `v1/` or `v2/` and copy
`build/legacy_pool/bytecode_modules/*.mv` into the matching `bytecode/` folder.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyze, canPayOut, roleGated, writesState, type Finding } from '../src/analyze.js';
import type { CallRef, FunctionModel, TypeRef } from '../src/bytecode.js';
import { parseModule } from '../src/bytecode.js';
import { toMarkdown, toText } from '../src/report.js';
import { decodeModuleMap, fetchVersions, loadVersionsFromDisk } from '../src/source.js';

// Compiled tests run from dist/test, so step back out to the source tree.
const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, '../../test/fixtures/legacy_pool/bytecode');
const moduleBytes = (version: string, name: string) =>
	new Uint8Array(readFileSync(path.join(fixture, version, `${name}.mv`)));

const find = (findings: Finding[], name: string) => findings.find((f) => f.function === name);

test('reports stale public logic that has no version check as high', async () => {
	const report = analyze(await loadVersionsFromDisk(fixture));
	const claim = find(report.findings, 'claim');
	assert.equal(claim?.severity, 'high');
	assert.equal(claim?.drift, 'changed');
	assert.deepEqual(claim?.objects, ['pool::Pool']);
	assert.deepEqual(claim?.versions.map((v) => v.version), [1]);
});

test('reports a private entry function that the upgrade removed as high', async () => {
	const report = analyze(await loadVersionsFromDisk(fixture));
	const sweep = find(report.findings, 'legacy_sweep');
	assert.equal(sweep?.severity, 'high');
	assert.equal(sweep?.drift, 'removed');
	assert.match(sweep!.signature, /^entry fun legacy_sweep\(&mut pool::Pool, &mut 0x2::tx_context::TxContext\)$/);
});

test('downgrades stale logic that needs a capability to low', async () => {
	const report = analyze(await loadVersionsFromDisk(fixture));
	const setRate = find(report.findings, 'set_rate');
	assert.equal(setRate?.severity, 'low');
	assert.equal(setRate?.capGated, true);
});

test('reports unchanged logic without a version check as info', async () => {
	const report = analyze(await loadVersionsFromDisk(fixture));
	const touch = find(report.findings, 'touch');
	assert.equal(touch?.severity, 'info');
	assert.equal(touch?.drift, 'same');
});

test('leaves out version-checked, read-only and package-internal functions', async () => {
	const report = analyze(await loadVersionsFromDisk(fixture));
	for (const name of ['deposit', 'funds', 'internal_reset', 'check'])
		assert.equal(find(report.findings, name), undefined, `${name} should not be reported`);
	assert.deepEqual(report.counts, { mutating: 5, readOnly: 0, versionChecked: 1, high: 2, medium: 0, low: 1, info: 1 });
	assert.equal(report.latestHasVersionChecks, true);
	assert.equal(report.latest.version, 2);
});

test('a package with one version has nothing to report', async () => {
	const [first] = await loadVersionsFromDisk(fixture);
	const report = analyze([first]);
	assert.equal(report.findings.length, 0);
	assert.match(toText(report), /Only one version exists/);
});

test('the order versions arrive in does not matter', async () => {
	const versions = await loadVersionsFromDisk(fixture);
	assert.deepEqual(analyze([...versions].reverse()), analyze(versions));
});

test('a source line shift does not count as a logic change', () => {
	const original = parseModule(moduleBytes('v1', 'guard'));
	const shifted = parseModule(moduleBytes('v1_shifted', 'guard'));
	assert.notDeepEqual(moduleBytes('v1', 'guard'), moduleBytes('v1_shifted', 'guard'));
	assert.equal(original.functions[0].bodyHash, shifted.functions[0].bodyHash);
});

test('a changed constant does count as a logic change', () => {
	const v1 = parseModule(moduleBytes('v1', 'guard'));
	const v2 = parseModule(moduleBytes('v2', 'guard'));
	assert.notEqual(v1.functions[0].bodyHash, v2.functions[0].bodyHash);
});

test('resolves parameters, calls and field reads to names', () => {
	const pool = parseModule(moduleBytes('v1', 'pool'));
	const deposit = pool.functions.find((f) => f.name === 'deposit')!;
	assert.equal(deposit.visibility, 'Public');
	assert.equal(deposit.params[0].ref, 'mut');
	assert.equal(deposit.params[0].datatype?.name, 'Pool');
	assert.equal(deposit.params[0].datatype?.hasKey, true);
	assert.ok(deposit.fields.some((f) => f.struct === 'Pool' && f.field === 'version'));
	assert.ok(deposit.calls.some((c) => c.module === 'guard' && c.name === 'check'));
	const sweep = pool.functions.find((f) => f.name === 'legacy_sweep')!;
	assert.equal(sweep.visibility, 'Private');
	assert.equal(sweep.isEntry, true);
});

test('decodes the module map that GraphQL returns', () => {
	const bcs = Uint8Array.from([2, 1, 0x61, 3, 9, 8, 7, 2, 0x62, 0x63, 0]);
	const modules = decodeModuleMap(bcs);
	assert.deepEqual([...modules.keys()], ['a', 'bc']);
	assert.deepEqual([...modules.get('a')!], [9, 8, 7]);
	assert.equal(modules.get('bc')!.length, 0);
	assert.throws(() => decodeModuleMap(Uint8Array.from([1, 5, 0x61])), /ended early/);
	assert.throws(() => decodeModuleMap(Uint8Array.from([0, 1])), /trailing/);
});

test('the markdown report lists every finding', async () => {
	const report = analyze(await loadVersionsFromDisk(fixture));
	const markdown = toMarkdown(report);
	for (const f of report.findings) assert.ok(markdown.includes(`\`${f.module}::${f.function}\``));
});

/** Encodes modules the way the GraphQL service does. */
function encodeModuleMap(modules: Map<string, Uint8Array>): string {
	const out: number[] = [];
	const uleb = (n: number) => {
		while (n >= 0x80) {
			out.push((n & 0x7f) | 0x80);
			n >>>= 7;
		}
		out.push(n);
	};
	uleb(modules.size);
	for (const [name, bytes] of modules) {
		const encoded = new TextEncoder().encode(name);
		uleb(encoded.length);
		out.push(...encoded);
		uleb(bytes.length);
		out.push(...bytes);
	}
	return Buffer.from(out).toString('base64');
}

test('fetches each version by number and analyses the result', async () => {
	const onDisk = await loadVersionsFromDisk(fixture);
	const requests: { query: string; variables: any }[] = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async (_url: any, init: any) => {
		const body = JSON.parse(init.body);
		requests.push(body);
		let data: unknown;
		if (body.query.includes('packageVersions')) {
			data = {
				packageVersions: {
					pageInfo: { hasNextPage: false, endCursor: null },
					nodes: onDisk.map((v) => ({ address: v.address, version: v.version })),
				},
			};
		} else {
			// Like the real service: the version decides which package comes back.
			const match = onDisk.find((v) => v.version === body.variables.version)!;
			data = { package: { address: match.address, version: match.version, moduleBcs: encodeModuleMap(match.modules) } };
		}
		return new Response(JSON.stringify({ data }), { status: 200 });
	}) as typeof fetch;
	try {
		const fetched = await fetchVersions('https://example.invalid/graphql', onDisk[1].address);
		assert.deepEqual(analyze(fetched), analyze(onDisk));
		const packageRequests = requests.filter((r) => !r.query.includes('packageVersions'));
		assert.deepEqual(packageRequests.map((r) => r.variables.version), [1, 2]);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test('a GraphQL error is reported, not swallowed', async () => {
	const realFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ errors: [{ message: 'boom' }] }), { status: 200 })) as typeof fetch;
	try {
		await assert.rejects(fetchVersions('https://example.invalid/graphql', '0x1'), /GraphQL error: boom/);
	} finally {
		globalThis.fetch = realFetch;
	}
});

const SUI_FW = '0x0000000000000000000000000000000000000000000000000000000000000002';
const fn = (calls: CallRef[], extra: Partial<FunctionModel> = {}): FunctionModel => ({
	module: 'm', name: 'f', visibility: 'Public', isEntry: false, params: [], calls, fields: [],
	mutatesFields: false, alwaysAborts: false, bodyHash: '', ...extra,
});

test('high findings now say they can pay coins out', async () => {
	const report = analyze(await loadVersionsFromDisk(fixture));
	assert.equal(find(report.findings, 'claim')?.canPayOut, true);
	assert.equal(find(report.findings, 'legacy_sweep')?.canPayOut, true);
});

test('a function that only takes coins in cannot pay out', () => {
	assert.equal(canPayOut([fn([{ address: SUI_FW, module: 'balance', name: 'join' }, { address: SUI_FW, module: 'coin', name: 'into_balance' }])]), false);
	assert.equal(canPayOut([fn([{ address: SUI_FW, module: 'balance', name: 'split' }])]), true);
	assert.equal(canPayOut([fn([{ address: SUI_FW, module: 'coin', name: 'from_balance' }])]), true);
	// A package's own module called `balance` is not the framework one.
	assert.equal(canPayOut([fn([{ address: '0xabc', module: 'balance', name: 'split' }])]), false);
});

test('a call that checks a role or access list counts as gated', () => {
	assert.equal(roleGated([fn([{ address: '0xabc', module: 'config', name: 'check_pool_manager_role' }])]), true);
	assert.equal(roleGated([fn([{ address: '0xabc', module: 'acl', name: 'has' }])]), true);
	assert.equal(roleGated([fn([{ address: '0xabc', module: 'pool', name: 'swap' }])]), false);
});

const pool = (ref: TypeRef['ref']): TypeRef => ({
	ref, repr: '&mut 0xabc::pool::Pool', datatype: { address: '0xabc', module: 'pool', name: 'Pool', hasKey: true },
});

test('taking an object mutably without writing a field does not count as a change', () => {
	// get_position_amounts(&mut Pool, ID) in Cetus v4-v12 only reads.
	assert.equal(writesState([fn([{ address: '0xabc', module: 'position', name: 'borrow_position_info' }])], [pool('mut')]), false);
	// A field write anywhere in the package code it reaches does count.
	assert.equal(writesState([fn([]), fn([], { mutatesFields: true })], [pool('mut')]), true);
	// Taking the object by value counts: it can be unpacked.
	assert.equal(writesState([fn([])], [pool('value')]), true);
	// A copy that always aborts changes nothing, whatever it reaches.
	assert.equal(writesState([fn([], { alwaysAborts: true, mutatesFields: true })], [pool('mut')]), false);
});

test('parses field writes and always-abort bodies from bytecode', async () => {
	const versions = await loadVersionsFromDisk(fixture);
	const fns = [...versions[0].modules.values()].flatMap((b) => parseModule(b).functions);
	const f = (name: string) => fns.find((x) => x.name === name)!;
	assert.equal(f('claim').mutatesFields, true);
	assert.equal(f('funds').mutatesFields, false);
	assert.equal(fns.some((x) => x.alwaysAborts), false);
});

test('a function the latest version disables is labelled as such', async () => {
	const report = analyze(await loadVersionsFromDisk(fixture));
	const claim = find(report.findings, 'claim')!;
	assert.equal(claim.disabledInLatest, false);
	claim.disabledInLatest = true;
	assert.match(toText(report), /claim {2}\(disabled in latest\)/);
	assert.match(toMarkdown(report), /`pool::claim` \| disabled \|/);
});

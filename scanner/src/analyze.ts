// Finds code in old versions of a package that can still be run against the
// protocol's live objects.
//
// On Sui an upgrade publishes a new package and leaves every earlier version
// on chain and callable. Types keep their original identity, so a function in
// version 1 accepts the same shared object that version 5 uses. Unless the
// old function checks a version number and refuses to run, a bug fixed in
// version 5 is still open in version 1.

import { createHash } from 'node:crypto';
import { parseModule, type FunctionModel, type ModuleModel, type TypeRef } from './bytecode.js';

export interface PackageVersion {
	/** The address this version is stored at. */
	address: string;
	version: number;
	/** Module name to compiled bytes. */
	modules: Map<string, Uint8Array>;
}

export type Severity = 'high' | 'medium' | 'low' | 'info';

export interface Finding {
	severity: Severity;
	module: string;
	function: string;
	/** `changed`: latest has different logic. `removed`: latest has no such function. `same`: identical to latest. */
	drift: 'changed' | 'removed' | 'same';
	/** True when the function needs an admin-style capability object. */
	capGated: boolean;
	/** True when the function checks the caller against a role or access list. */
	roleGated: boolean;
	/** True when the function, or package code it calls, can take coins out of a balance. */
	canPayOut: boolean;
	/** True when the latest version of this function always aborts, so the old copy is the only one that still runs. */
	disabledInLatest: boolean;
	/** The protocol objects this function can modify. */
	objects: string[];
	signature: string;
	/** Old versions where this exact logic is callable without a version check. */
	versions: { version: number; address: string }[];
	why: string;
}

export interface Report {
	originalId: string;
	latest: { version: number; address: string };
	versionsScanned: number;
	/** True when the latest version shows any sign of a version check. */
	latestHasVersionChecks: boolean;
	counts: {
		/** Old-version functions that can modify protocol objects. */
		mutating: number;
		/** Old-version functions that take a protocol object mutably but only read it, or always abort. Not reported. */
		readOnly: number;
		/** Of those, the ones protected by a version check. */
		versionChecked: number;
		high: number;
		medium: number;
		low: number;
		info: number;
	};
	findings: Finding[];
}

const VERSION_NAME = /version/i;
const ROLE_NAME = /(role|acl|auth|permission|whitelist|allowlist)/i;
const SUI = /^0x0*2$/;
const PAYOUT: Record<string, RegExp> = {
	balance: /^(split|withdraw_all)$/,
	coin: /^(take|split|from_balance|divide_into_n)$/,
};
const CAPABILITY_NAME = /(cap|admin|owner|operator|governor|governance)$/i;

interface Indexed {
	modules: ModuleModel[];
	byKey: Map<string, FunctionModel>;
	selfAddress: string;
}

function index(version: PackageVersion): Indexed {
	const modules = [...version.modules.values()].map(parseModule);
	const byKey = new Map<string, FunctionModel>();
	for (const mod of modules) for (const f of mod.functions) byKey.set(`${mod.name}::${f.name}`, f);
	return { modules, byKey, selfAddress: modules[0]?.address ?? '' };
}

/** The function plus everything it reaches inside its own package. */
function closure(pkg: Indexed, root: FunctionModel): FunctionModel[] {
	const seen = new Map<string, FunctionModel>();
	const stack = [root];
	while (stack.length) {
		const f = stack.pop()!;
		const key = `${f.module}::${f.name}`;
		if (seen.has(key)) continue;
		seen.set(key, f);
		for (const call of f.calls) {
			if (call.address !== pkg.selfAddress) continue;
			const callee = pkg.byKey.get(`${call.module}::${call.name}`);
			if (callee) stack.push(callee);
		}
	}
	return [...seen.values()];
}

/** One hash for a function and all the package code it depends on. */
function closureHash(reachable: FunctionModel[]): string {
	const lines = reachable.map((f) => `${f.module}::${f.name}:${f.bodyHash}`).sort();
	return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/**
 * Looks for the usual ways a Sui package pins itself to one version:
 * reading a field called `version`, calling something named for version
 * checking (including `sui::versioned`), or taking a `Version` object.
 */
function versionCheckEvidence(reachable: FunctionModel[]): string | null {
	for (const f of reachable) {
		const field = f.fields.find((x) => VERSION_NAME.test(x.field));
		if (field) return `reads ${field.struct}.${field.field} in ${f.module}::${f.name}`;
		const call = f.calls.find((c) => VERSION_NAME.test(c.name) || VERSION_NAME.test(c.module));
		if (call) return `calls ${call.module}::${call.name} in ${f.module}::${f.name}`;
		const param = f.params.find((p) => p.datatype && VERSION_NAME.test(p.datatype.name));
		if (param) return `takes ${param.datatype!.name} in ${f.module}::${f.name}`;
	}
	return null;
}

/** Any reachable call that takes coins out of a balance. */
export function canPayOut(reachable: FunctionModel[]): boolean {
	return reachable.some((f) =>
		f.calls.some((c) => SUI.test(c.address) && PAYOUT[c.module]?.test(c.name) === true),
	);
}

/** Any reachable call that checks the caller against a role or access list. */
export function roleGated(reachable: FunctionModel[]): boolean {
	return reachable.some((f) => f.calls.some((c) => ROLE_NAME.test(c.name) || ROLE_NAME.test(c.module)));
}

/**
 * Whether the function can actually change one of the given objects. Only the
 * package that defines a type can borrow its fields mutably, so a change needs
 * a `MutBorrowField` somewhere in the package code the function reaches.
 * Taking the object by value counts too, since it can then be unpacked.
 */
export function writesState(reachable: FunctionModel[], objects: TypeRef[]): boolean {
	if (reachable[0]?.alwaysAborts) return false;
	return objects.some((o) => o.ref === 'value') || reachable.some((f) => f.mutatesFields);
}

const isCapability = (p: TypeRef) => !!p.datatype?.hasKey && CAPABILITY_NAME.test(p.datatype.name);

/** Parameters through which the function can change an object defined by this package. */
function mutableProtocolObjects(pkg: Indexed, f: FunctionModel): TypeRef[] {
	return f.params.filter(
		(p) =>
			p.ref !== 'imm' &&
			p.datatype?.hasKey === true &&
			p.datatype.address === pkg.selfAddress &&
			!isCapability(p),
	);
}

/** Drops the package's own address and the zero padding of others: `&mut pool::Pool`, `0x2::coin::Coin`. */
function readable(repr: string, selfAddress: string): string {
	return repr.replaceAll(`${selfAddress}::`, '').replace(/0x0+(?=[0-9a-f])/g, '0x');
}

const callableFromOutside = (f: FunctionModel) => f.visibility === 'Public' || f.isEntry;

export function analyze(versions: PackageVersion[]): Report {
	if (versions.length === 0) throw new Error('No package versions to analyse');
	const sorted = [...versions].sort((a, b) => a.version - b.version);
	const latestVersion = sorted[sorted.length - 1];
	const latest = index(latestVersion);

	const latestHasVersionChecks = [...latest.byKey.values()].some(
		(f) => versionCheckEvidence([f]) !== null,
	);

	const counts = { mutating: 0, readOnly: 0, versionChecked: 0, high: 0, medium: 0, low: 0, info: 0 };
	const grouped = new Map<string, Finding>();

	for (const old of sorted.slice(0, -1)) {
		const pkg = index(old);
		for (const f of pkg.byKey.values()) {
			if (!callableFromOutside(f)) continue;
			const objects = mutableProtocolObjects(pkg, f);
			if (objects.length === 0) continue;

			const reachable = closure(pkg, f);
			if (!writesState(reachable, objects)) {
				counts.readOnly++;
				continue;
			}
			counts.mutating++;
			if (versionCheckEvidence(reachable)) {
				counts.versionChecked++;
				continue;
			}

			const key = `${f.module}::${f.name}`;
			const current = latest.byKey.get(key);
			const hash = closureHash(reachable);
			const drift: Finding['drift'] = !current
				? 'removed'
				: closureHash(closure(latest, current)) === hash
					? 'same'
					: 'changed';
			const capGated = f.params.some(isCapability);
			const roles = roleGated(reachable);
			const payout = canPayOut(reachable);
			const disabledInLatest = current?.alwaysAborts === true;
			const verb = drift === 'removed' ? 'removed from' : disabledInLatest ? 'disabled in' : 'changed in';

			let severity: Severity;
			let why: string;
			if (drift === 'same') {
				severity = 'info';
				why = 'No version check, but the logic matches the latest version, so there is nothing stale to exploit today. A future fix to this function will not reach this copy.';
			} else if (capGated || roles) {
				severity = 'low';
				why = `No version check and the logic was ${verb} the latest version, but calling it needs ${capGated ? 'a capability object' : 'a role the caller is checked against'}.`;
			} else if (!payout) {
				severity = 'medium';
				why = `Anyone can call this older copy, it has no version check, and the logic was ${verb} the latest version. It has no path that takes coins out, so it cannot drain funds by itself, but it can change protocol state with outdated rules.`;
			} else {
				severity = 'high';
				why =
					drift === 'removed'
						? 'The latest version removed this function, yet this copy can still be called by anyone, has no version check, and can pay coins out.'
						: disabledInLatest
							? 'The latest version disables this function (it always aborts), yet this older copy can still be called by anyone, has no version check, and can pay coins out.'
							: 'The latest version changed this logic, yet this older copy can still be called by anyone, has no version check, and can pay coins out.';
			}

			const groupKey = `${key}:${hash}`;
			const existing = grouped.get(groupKey);
			if (existing) {
				existing.versions.push({ version: old.version, address: old.address });
			} else {
				grouped.set(groupKey, {
					severity,
					module: f.module,
					function: f.name,
					drift,
					capGated,
					roleGated: roles,
					canPayOut: payout,
					disabledInLatest,
					objects: objects.map((o) => `${o.datatype!.module}::${o.datatype!.name}`),
					signature: `${f.visibility === 'Public' ? 'public ' : ''}${f.isEntry ? 'entry ' : ''}fun ${f.name}(${f.params.map((p) => readable(p.repr, pkg.selfAddress)).join(', ')})`,
					versions: [{ version: old.version, address: old.address }],
					why,
				});
			}
		}
	}

	const order: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };
	const findings = [...grouped.values()].sort(
		(a, b) =>
			order[a.severity] - order[b.severity] ||
			a.module.localeCompare(b.module) ||
			a.function.localeCompare(b.function),
	);
	for (const f of findings) counts[f.severity]++;

	return {
		originalId: latest.selfAddress,
		latest: { version: latestVersion.version, address: latestVersion.address },
		versionsScanned: sorted.length,
		latestHasVersionChecks,
		counts,
		findings,
	};
}

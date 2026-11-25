// Where package versions come from: Sui's GraphQL RPC, or a folder on disk.

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { PackageVersion } from './analyze.js';

export const ENDPOINTS: Record<string, string> = {
	mainnet: 'https://graphql.mainnet.sui.io/graphql',
	testnet: 'https://graphql.testnet.sui.io/graphql',
	devnet: 'https://graphql.devnet.sui.io/graphql',
};

const VERSIONS_QUERY = `
query Versions($address: SuiAddress!, $after: String) {
  packageVersions(address: $address, first: 50, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { address version }
  }
}`;

const PACKAGE_QUERY = `
query Package($address: SuiAddress!, $version: UInt53!) {
  package(address: $address, version: $version) { address version moduleBcs }
}`;

async function graphql<T>(endpoint: string, query: string, variables: object): Promise<T> {
	const response = await fetch(endpoint, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ query, variables }),
	});
	if (!response.ok) throw new Error(`GraphQL request failed: HTTP ${response.status} from ${endpoint}`);
	const body = (await response.json()) as { data?: T; errors?: { message: string }[] };
	if (body.errors?.length) throw new Error(`GraphQL error: ${body.errors.map((e) => e.message).join('; ')}`);
	if (!body.data) throw new Error('GraphQL response had no data');
	return body.data;
}

/**
 * `moduleBcs` is a BCS map of module name to module bytes: a ULEB128 count,
 * then for each entry a length-prefixed name and length-prefixed bytes.
 */
export function decodeModuleMap(bytes: Uint8Array): Map<string, Uint8Array> {
	let at = 0;
	const uleb = (): number => {
		let value = 0;
		let shift = 0;
		for (;;) {
			if (at >= bytes.length) throw new Error('moduleBcs ended early');
			const byte = bytes[at++];
			value |= (byte & 0x7f) << shift;
			if ((byte & 0x80) === 0) return value >>> 0;
			shift += 7;
			if (shift > 28) throw new Error('moduleBcs has a length that is too large');
		}
	};
	const take = (length: number): Uint8Array => {
		if (at + length > bytes.length) throw new Error('moduleBcs ended early');
		const slice = bytes.subarray(at, at + length);
		at += length;
		return slice;
	};
	const modules = new Map<string, Uint8Array>();
	const count = uleb();
	for (let i = 0; i < count; i++) {
		const name = new TextDecoder().decode(take(uleb()));
		modules.set(name, take(uleb()));
	}
	if (at !== bytes.length) throw new Error('moduleBcs has trailing bytes');
	return modules;
}

/** Every version of the package that `address` belongs to. `address` can be any version. */
export async function fetchVersions(endpoint: string, address: string): Promise<PackageVersion[]> {
	const listed: { address: string; version: number }[] = [];
	let after: string | null = null;
	do {
		const data: {
			packageVersions: {
				pageInfo: { hasNextPage: boolean; endCursor: string | null };
				nodes: { address: string; version: number }[];
			} | null;
		} = await graphql(endpoint, VERSIONS_QUERY, { address, after });
		const page = data.packageVersions;
		if (!page) break;
		listed.push(...page.nodes);
		after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
	} while (after);
	if (listed.length === 0) throw new Error(`No package found at ${address}`);

	const versions: PackageVersion[] = [];
	for (const item of listed) {
		// The version must be passed: without it the service answers with the
		// latest version of the package, whichever version's address was asked for.
		const data = await graphql<{
			package: { address: string; version: number; moduleBcs: string | null } | null;
		}>(endpoint, PACKAGE_QUERY, { address: item.address, version: item.version });
		if (!data.package?.moduleBcs) throw new Error(`Could not load modules for ${item.address}`);
		if (data.package.address !== item.address || data.package.version !== item.version)
			throw new Error(
				`Asked for v${item.version} at ${item.address} but received v${data.package.version} at ${data.package.address}`,
			);
		versions.push({
			address: item.address,
			version: item.version,
			modules: decodeModuleMap(Buffer.from(data.package.moduleBcs, 'base64')),
		});
	}
	return versions;
}

/**
 * Loads versions from disk. The folder holds `manifest.json`:
 * `{ "versions": [{ "version": 1, "address": "0x...", "dir": "v1" }] }`
 * and each `dir` holds that version's compiled `.mv` files.
 */
export async function loadVersionsFromDisk(folder: string): Promise<PackageVersion[]> {
	const manifest = JSON.parse(await readFile(path.join(folder, 'manifest.json'), 'utf8')) as {
		versions: { version: number; address: string; dir: string }[];
	};
	return Promise.all(
		manifest.versions.map(async (entry) => {
			const dir = path.join(folder, entry.dir);
			const modules = new Map<string, Uint8Array>();
			for (const file of (await readdir(dir)).filter((f) => f.endsWith('.mv')).sort()) {
				modules.set(path.basename(file, '.mv'), new Uint8Array(await readFile(path.join(dir, file))));
			}
			return { address: entry.address, version: entry.version, modules };
		}),
	);
}

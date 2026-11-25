#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { analyze } from './analyze.js';
import { toMarkdown, toText } from './report.js';
import { ENDPOINTS, fetchVersions, loadVersionsFromDisk } from './source.js';

const HELP = `fusebox: find old Sui package versions that can still touch live objects

Usage
  fusebox scan <package-address> [options]
  fusebox scan --dir <folder> [options]

Options
  --network <name>   mainnet (default), testnet or devnet
  --endpoint <url>   use a specific GraphQL endpoint instead
  --dir <folder>     read versions from disk (manifest.json plus .mv files)
  --json             print the full report as JSON
  --md <file>        also write the report as Markdown
  --help             show this text

Exit code is 1 when a HIGH finding exists, so it can gate a CI job.`;

function fail(message: string): never {
	console.error(`fusebox: ${message}`);
	process.exit(2);
}

async function main() {
	const args = process.argv.slice(2);
	if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
		console.log(HELP);
		return;
	}
	if (args[0] !== 'scan') fail(`unknown command "${args[0]}". Try --help.`);

	let address: string | undefined;
	let network = 'mainnet';
	let endpoint: string | undefined;
	let dir: string | undefined;
	let markdown: string | undefined;
	let json = false;

	for (let i = 1; i < args.length; i++) {
		const arg = args[i];
		const value = () => args[++i] ?? fail(`${arg} needs a value`);
		if (arg === '--network') network = value();
		else if (arg === '--endpoint') endpoint = value();
		else if (arg === '--dir') dir = value();
		else if (arg === '--md') markdown = value();
		else if (arg === '--json') json = true;
		else if (arg.startsWith('--')) fail(`unknown option ${arg}`);
		else address = arg;
	}

	let versions;
	if (dir) {
		versions = await loadVersionsFromDisk(dir);
	} else {
		if (!address) fail('give a package address, or --dir <folder>');
		if (!/^0x[0-9a-fA-F]{1,64}$/.test(address)) fail(`"${address}" is not a Sui address`);
		const url = endpoint ?? ENDPOINTS[network] ?? fail(`unknown network "${network}"`);
		versions = await fetchVersions(url, address);
	}

	const report = analyze(versions);
	console.log(json ? JSON.stringify(report, null, 2) : toText(report));
	if (markdown) await writeFile(markdown, toMarkdown(report) + '\n');
	if (report.counts.high > 0) process.exitCode = 1;
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));

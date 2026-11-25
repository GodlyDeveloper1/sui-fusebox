import type { Finding, Report } from './analyze.js';

const LABEL: Record<Finding['severity'], string> = { high: 'HIGH', medium: 'MED ', low: 'LOW ', info: 'INFO' };

const drift = (f: Finding) => (f.disabledInLatest ? 'disabled' : f.drift);

const short = (address: string) => (address.length > 14 ? `${address.slice(0, 8)}…${address.slice(-4)}` : address);

function headline(report: Report): string {
	const { high, medium, low, info } = report.counts;
	if (report.versionsScanned === 1) return 'Only one version exists, so there is no older code to check.';
	if (high > 0)
		return `${high} function${high === 1 ? '' : 's'} in old versions can still be called by anyone, pay coins out, and run logic the latest version changed or removed.`;
	if (medium > 0)
		return `No stale code that can pay coins out is open to the public. ${medium} old function${medium === 1 ? '' : 's'} can still change protocol state with outdated rules.`;
	if (low + info > 0) return 'No stale logic is open to the public, but some old functions run without a version check.';
	return 'Every old function that can modify protocol objects is behind a version check.';
}

export function toText(report: Report): string {
	const lines: string[] = [];
	lines.push(`Package   ${report.originalId}`);
	lines.push(`Latest    v${report.latest.version} at ${report.latest.address}`);
	lines.push(`Versions  ${report.versionsScanned}`);
	lines.push('');
	lines.push(headline(report));
	if (report.versionsScanned > 1) {
		const c = report.counts;
		lines.push(
			`${c.mutating} old function cop${c.mutating === 1 ? 'y' : 'ies'} can modify protocol objects; ${c.versionChecked} of them ${c.versionChecked === 1 ? 'is' : 'are'} version checked.`,
		);
		if (c.readOnly > 0)
			lines.push(
				`${c.readOnly} more take a protocol object mutably but only read it or always abort, so they are not reported.`,
			);
		if (!report.latestHasVersionChecks)
			lines.push('The latest version shows no version checks at all, so every future upgrade will leave today\'s code callable.');
	}
	for (const f of report.findings) {
		lines.push('');
		lines.push(`[${LABEL[f.severity]}] ${f.module}::${f.function}  (${drift(f)} in latest)`);
		lines.push(`  ${f.signature}`);
		lines.push(`  can modify: ${f.objects.join(', ')}`);
		lines.push(`  callable in: ${f.versions.map((v) => `v${v.version} ${short(v.address)}`).join(', ')}`);
		lines.push(`  ${f.why}`);
	}
	return lines.join('\n');
}

export function toMarkdown(report: Report): string {
	const lines: string[] = [];
	lines.push(`# Legacy code report`);
	lines.push('');
	lines.push(`- **Package:** \`${report.originalId}\``);
	lines.push(`- **Latest version:** v${report.latest.version} at \`${report.latest.address}\``);
	lines.push(`- **Versions scanned:** ${report.versionsScanned}`);
	lines.push('');
	lines.push(headline(report));
	if (report.findings.length) {
		lines.push('');
		lines.push('| Severity | Function | Drift | Can modify | Callable in |');
		lines.push('| --- | --- | --- | --- | --- |');
		for (const f of report.findings) {
			lines.push(
				`| ${f.severity} | \`${f.module}::${f.function}\` | ${drift(f)} | ${f.objects.map((o) => `\`${o}\``).join(', ')} | ${f.versions.map((v) => `v${v.version}`).join(', ')} |`,
			);
		}
		for (const f of report.findings) {
			lines.push('');
			lines.push(`## ${f.severity.toUpperCase()}: \`${f.module}::${f.function}\``);
			lines.push('');
			lines.push('```move');
			lines.push(f.signature);
			lines.push('```');
			lines.push('');
			lines.push(f.why);
			lines.push('');
			for (const v of f.versions) lines.push(`- v${v.version}: \`${v.address}\``);
		}
	}
	lines.push('');
	lines.push(
		'_Version checks are detected by pattern (a `version` field, a version-named call, a `Version` object). A function reported here may still be safe for a reason the scanner cannot see, and a HIGH finding is a lead to review, not proof of an exploit._',
	);
	return lines.join('\n');
}

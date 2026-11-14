/**
 * Packaging guard: the shipped files must be byte-clean.
 *
 * A BOM written by a Windows editor/PowerShell turned into
 * `Unexpected token '﻿', "﻿{ "n"... is not valid JSON` and made the whole
 * plugin show as "包不可用" in the plugins page, because the Host parses
 * package.json with JSON.parse (which rejects a leading U+FEFF).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert";

const BUNDLE = fileURLToPath(new URL("..", import.meta.url));
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

const SHIPPED = [
	"package.json",
	"index.js",
	"client.js",
	"cordis.patch.yml",
	"README.md",
	"LICENSE",
	"icon.svg"
];

let passed = 0;
let failed = 0;
const test = (name, fn) => {
	try {
		fn();
		console.log("PASS  " + name);
		passed++;
	} catch (e) {
		console.log("FAIL  " + name + "\n      " + (e && e.message ? e.message : String(e)));
		failed++;
	}
};

test("P1 package.json parses as JSON", () => {
	const file = path.join(BUNDLE, "package.json");
	const raw = fs.readFileSync(file, "utf8");
	const parsed = JSON.parse(raw); // throws on a leading BOM — the reported failure
	assert.strictEqual(typeof parsed.name, "string");
	assert.match(parsed.version, /^\d+\.\d+\.\d+/);
});

test("P2 no shipped file starts with a BOM", () => {
	const offenders = [];
	for (const name of SHIPPED) {
		const file = path.join(BUNDLE, name);
		if (!fs.existsSync(file)) continue;
		const head = fs.readFileSync(file).subarray(0, 3);
		if (head.equals(BOM)) offenders.push(name);
	}
	assert.deepStrictEqual(offenders, [], "these files carry a BOM: " + offenders.join(", "));
});

test("P3 every shipped JSON file parses as JSON", () => {
	const offenders = [];
	for (const name of SHIPPED.filter((n) => n.endsWith(".json"))) {
		const file = path.join(BUNDLE, name);
		if (!fs.existsSync(file)) continue;
		try {
			JSON.parse(fs.readFileSync(file, "utf8"));
		} catch (e) {
			offenders.push(`${name}: ${e && e.message ? e.message : String(e)}`);
		}
	}
	// Locale dictionaries ship inside the package too.
	const localeDir = path.join(BUNDLE, "locale");
	if (fs.existsSync(localeDir)) {
		for (const name of fs.readdirSync(localeDir).filter((n) => n.endsWith(".json"))) {
			const file = path.join(localeDir, name);
			try {
				JSON.parse(fs.readFileSync(file, "utf8"));
			} catch (e) {
				offenders.push(`locale/${name}: ${e && e.message ? e.message : String(e)}`);
			}
		}
	}
	assert.deepStrictEqual(offenders, [], "unparsable JSON: " + offenders.join(" | "));
});

test("P4 the declared entry files all exist", () => {
	const pkg = JSON.parse(fs.readFileSync(path.join(BUNDLE, "package.json"), "utf8"));
	for (const target of Object.values(pkg.exports ?? {})) {
		if (typeof target !== "string" || target.includes("*")) continue;
		assert.ok(fs.existsSync(path.join(BUNDLE, target)), "missing export target: " + target);
	}
	for (const file of pkg.files ?? []) {
		if (file.includes("*")) continue;
		assert.ok(fs.existsSync(path.join(BUNDLE, file)), "missing files entry: " + file);
	}
});

test("P5 the bundle patch declares the package's own name", () => {
	// The Loader resolves the row's `name` as a module specifier. A patch that
	// names something else (the repo name instead of the package name) is the
	// other classic route to "包不可用" / "异常".
	const pkg = JSON.parse(fs.readFileSync(path.join(BUNDLE, "package.json"), "utf8"));
	const patchPath = path.join(BUNDLE, "cordis.patch.yml");
	assert.ok(fs.existsSync(patchPath), "missing cordis.patch.yml");
	const text = fs.readFileSync(patchPath, "utf8");
	const declared = [];
	for (const line of text.split("\n")) {
		const m = line.match(/^\s*-?\s*name:\s*['"]?([^'"\r\n]+?)['"]?\s*$/);
		if (m) declared.push(m[1]);
	}
	assert.ok(declared.length > 0, "patch declares no name: " + JSON.stringify(text));
	const mismatched = declared.filter((n) => n !== pkg.name);
	assert.deepStrictEqual(mismatched, [],
		`patch name(s) ${JSON.stringify(mismatched)} must equal package name "${pkg.name}"`);
});

console.log(`\nPACKAGE GUARD: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
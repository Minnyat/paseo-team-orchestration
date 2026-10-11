/**
 * config-form.js — pure helpers for the schema-driven config editor.
 *
 * No DOM here on purpose: every function is plain data-in/data-out so the
 * merge semantics (a save may never drop a key the form does not know about)
 * are testable from Node like any other contract.
 *
 * Paths. A location in the document is an ARRAY of segments: object keys as
 * strings, list positions as numbers. A map key is user data and may be any
 * non-empty string — `mac.local`, `gpt-5.5`, `poolside/laguna-s-2.1` — so it is
 * always one segment, never glued into a dotted string and split back apart
 * (that turned host `mac.local` into host `mac` with a child `local`, and the
 * form edited, renamed and deleted the wrong entry). The schema's own field
 * paths (`connection.type`) are fixed identifiers written with dots; they are
 * split in exactly one place, `fieldPath`, and appended to the item's segments.
 */

export function clone(value) {
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function segmentsOf(path) {
	if (!Array.isArray(path)) {
		// A dotted string here is the old model coming back: refuse it loudly
		// rather than guess which dots were separators and which were data.
		throw new TypeError(`config-form: a path is an array of segments, got ${JSON.stringify(path)}`);
	}
	return path;
}

/** The segments of a schema field path (`"limits.writers"`) under an item's own segments. */
export function fieldPath(prefix, schemaPath) {
	return [...segmentsOf(prefix), ...String(schemaPath).split(".")];
}

/**
 * A path for people to read in a message: `hosts."mac.local".routes.FAST_READ`,
 * `jobs.review.executors[0]`. A segment that is not a plain identifier is quoted
 * so a dotted key cannot be mistaken for two levels.
 */
export function displayPath(path) {
	let out = "";
	for (const segment of segmentsOf(path)) {
		if (typeof segment === "number") out += `[${segment}]`;
		else out += `${out ? "." : ""}${/^[A-Za-z0-9_-]+$/.test(segment) ? segment : JSON.stringify(segment)}`;
	}
	return out;
}

/**
 * Only OWN properties are followed. A key is user data, and `constructor` or
 * `__proto__` read through to the prototype would hand back Object itself (and
 * a write through it would change every object on the page).
 */
function own(node, key) {
	return node !== null && typeof node === "object" && Object.hasOwn(node, key) ? node[key] : undefined;
}

export function getPath(root, path) {
	let node = root;
	for (const part of segmentsOf(path)) {
		if (node === null || typeof node !== "object") return undefined;
		node = own(node, part);
	}
	return node;
}

export function setPath(root, path, value) {
	const parts = segmentsOf(path);
	let node = root;
	parts.slice(0, -1).forEach((part, index) => {
		const child = own(node, part);
		if (typeof child !== "object" || child === null) assign(node, part, typeof parts[index + 1] === "number" ? [] : {});
		node = own(node, part);
	});
	assign(node, parts[parts.length - 1], value);
}

/**
 * `node[key] = value`, as an own data property even when the name is one the
 * prototype carries: `__proto__` must become a key like any other (as
 * JSON.parse makes it), not replace the object's prototype. Every non-empty
 * string is a valid map key.
 */
function assign(node, key, value) {
	if (!Object.hasOwn(node, key)) {
		Object.defineProperty(node, key, { value, writable: true, enumerable: true, configurable: true });
	} else {
		node[key] = value;
	}
}

/**
 * Delete a leaf and any now-empty parents, so a reset field leaves no `"retry": {}` husk.
 *
 * A list element is never removed this way, even when it empties: deleting from
 * an array leaves a hole, and shifting it would renumber every element after it.
 * Removing an element is the list control's job (`removeAt`).
 */
export function deletePath(root, path) {
	const parts = segmentsOf(path);
	if (typeof root !== "object" || root === null || parts.length === 0) return;
	deleteRec(root, parts);

	function deleteRec(node, rest) {
		if (rest.length === 1) {
			if (!Array.isArray(node)) delete node[rest[0]];
			return;
		}
		const child = own(node, rest[0]);
		if (typeof child !== "object" || child === null) return;
		deleteRec(child, rest.slice(1));
		if (!Array.isArray(node) && !Array.isArray(child) && Object.keys(child).length === 0) delete node[rest[0]];
	}
}

/** Remove one element of the list at `path`. */
export function removeAt(root, path, index) {
	const list = getPath(root, path);
	if (Array.isArray(list) && index >= 0 && index < list.length) list.splice(index, 1);
}

/** Swap list element `index` with its neighbour `index + delta`; out of range is a no-op. */
export function moveAt(root, path, index, delta) {
	const list = getPath(root, path);
	const to = index + delta;
	if (!Array.isArray(list) || index < 0 || index >= list.length || to < 0 || to >= list.length) return;
	[list[index], list[to]] = [list[to], list[index]];
}

/** Deep-merge a preset patch onto the working document (arrays and scalars replace). */
export function deepMerge(target, patch) {
	for (const [key, value] of Object.entries(patch ?? {})) {
		if (value !== null && typeof value === "object" && !Array.isArray(value)) {
			if (typeof target[key] !== "object" || target[key] === null) target[key] = {};
			deepMerge(target[key], value);
		} else {
			target[key] = value;
		}
	}
	return target;
}

/**
 * Drop empty objects/arrays so a save writes the smallest document that still
 * means the same thing. False, 0 and "" are values, not emptiness.
 *
 * Array elements are left as they are: arrays here are mostly data the form
 * does not model, and a list element's insides are cleaned schema-aware by
 * cleanListItems instead.
 */
export function pruneEmpty(value) {
	if (Array.isArray(value)) return value.length > 0 ? value : undefined;
	if (value !== null && typeof value === "object") {
		// fromEntries, not `out[key] = …`: a key spelled __proto__ must stay a key.
		const out = Object.fromEntries(
			Object.entries(value)
				.map(([key, child]) => [key, pruneEmpty(child)])
				.filter(([, kept]) => kept !== undefined),
		);
		return Object.keys(out).length > 0 ? out : undefined;
	}
	return value;
}

/**
 * The segments of every item a `map` or `list` field holds in `doc` right now:
 * `[...path, key]` for a map, `[...path, index]` for a list. Anything else, or
 * a value of the wrong shape, holds no items.
 */
export function itemPaths(field, doc, path) {
	if (!field?.item) return [];
	const value = getPath(doc, path);
	if (field.type === "map") {
		return value !== null && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).map((key) => [...path, key]) : [];
	}
	if (field.type === "list") return Array.isArray(value) ? value.map((_, index) => [...path, index]) : [];
	return [];
}

/**
 * Visit every schema field at every place it occurs in `doc`, depth first:
 * `visit(field, base)` where `base` is the segments of the object the field
 * lives in ([] at the top level, `["hosts", "mac.local"]`, `[..., "executors", 0]`).
 */
function eachField(schema, doc, prefix, visit) {
	for (const group of schema?.groups ?? []) {
		for (const field of group.fields ?? []) walk(field, prefix);
	}
	function walk(field, base) {
		visit(field, base);
		for (const item of itemPaths(field, doc, fieldPath(base, field.path))) {
			for (const child of field.item.fields ?? []) walk(child, item);
		}
	}
}

/**
 * Is `field`, living in the object at `base`, shown right now? `showIf` names a
 * sibling in the same object. The form's visibility and the save-time cleanup
 * both ask this one function, so what is hidden is exactly what is dropped.
 */
export function isShown(field, doc, base = []) {
	if (!field?.showIf) return true;
	return String(getPath(doc, fieldPath(base, field.showIf.path))) === String(field.showIf.equals);
}

/**
 * Put back the empty lists a reader insists on, after pruneEmpty took them out.
 *
 * pruneEmpty treats `[]` as "not set", which holds for almost every list here,
 * but not for a field the schema marks `keepEmpty`: a cluster host's
 * `capabilities` must be an array even when it is empty, and without it
 * validateClusterConfig refuses the whole file. A field is restored only inside
 * an item that survived the prune — a removed host does not come back as a husk.
 */
export function fillKeptEmpty(schema, doc) {
	if (doc === null || typeof doc !== "object") return doc;
	eachField(schema, doc, [], (field, base) => {
		if (!field.keepEmpty) return;
		const holder = base.length > 0 ? getPath(doc, base) : doc;
		if (holder === null || typeof holder !== "object" || Array.isArray(holder)) return;
		const path = fieldPath(base, field.path);
		if (getPath(doc, path) === undefined) setPath(doc, path, []);
	});
	return doc;
}

/**
 * Tidy every `list` element before a save, in place: a field its `showIf` now
 * hides is dropped (switching an executor from `route` to `cli` must not carry
 * its old `model` along — the validator refuses a key of another kind), and the
 * element's own empty objects/lists are pruned. The element itself stays, even
 * when that leaves `{}`: dropping it would renumber its neighbours, and the
 * validator says more about an empty element than a silent disappearance.
 *
 * Only list elements are touched. A hidden field elsewhere (a local host's
 * `endpointEnv`) is kept, as it always was.
 */
export function cleanListItems(schema, doc) {
	if (doc === null || typeof doc !== "object") return doc;
	eachField(schema, doc, [], (field, base) => {
		if (field.type !== "list" || !field.item) return;
		const path = fieldPath(base, field.path);
		const list = getPath(doc, path);
		for (const item of itemPaths(field, doc, path)) {
			const element = getPath(doc, item);
			if (element === null || typeof element !== "object" || Array.isArray(element)) continue;
			// Decide every field's visibility before deleting any: a field that
			// another one's showIf reads must not vanish halfway through.
			const hidden = (field.item.fields ?? []).filter((child) => !isShown(child, doc, item));
			for (const child of hidden) deletePath(doc, fieldPath(item, child.path));
			list[item.at(-1)] = pruneEmpty(element) ?? {};
		}
	});
	return doc;
}

/** One entry per number field outside its range, with the label to show the user. */
export function numberRangeProblems(schema, doc, prefix = []) {
	const problems = [];
	eachField(schema, doc, prefix, (field, base) => {
		if (field.type !== "number") return;
		const value = getPath(doc, fieldPath(base, field.path));
		if (value === undefined || value === null || value === "") return;
		const numeric = Number(value);
		if (!Number.isFinite(numeric) || numeric < (field.min ?? -Infinity) || numeric > (field.max ?? Infinity)) {
			problems.push(`${field.label} phải là số từ ${field.min ?? "−∞"} đến ${field.max ?? "∞"}`);
		}
	});
	return problems;
}

/** One entry per `list` holding fewer elements than its `minItems`. */
export function listLengthProblems(schema, doc, prefix = []) {
	const problems = [];
	eachField(schema, doc, prefix, (field, base) => {
		if (field.type !== "list" || !(field.minItems > 0)) return;
		const path = fieldPath(base, field.path);
		const value = getPath(doc, path);
		const count = Array.isArray(value) ? value.length : 0;
		if (count < field.minItems) {
			problems.push(`${displayPath(path)}: ${field.label ?? field.path} cần ít nhất ${field.minItems} mục (đang có ${count})`);
		}
	});
	return problems;
}

/**
 * The options a dependent field offers right now.
 *
 * `optionsBy` names a SIBLING field inside the same map item, so the
 * list follows whatever that sibling currently holds — a route's model and
 * thinking level follow its `paseoProvider`. An unset or unrecognised sibling
 * yields an empty list, never another family's values: offering pi's `minimal`
 * for a Claude route is exactly the confusion this replaced.
 *
 * `prefix` is the segments of the item the field lives in
 * (`["routes", "REVIEW_HIGH"]`), or [] for a top-level field.
 */
export function dependentOptions(spec, doc, prefix = []) {
	if (spec === null || typeof spec !== "object") return null;
	const current = getPath(doc, fieldPath(prefix, spec.path));
	if (current === undefined || current === null) return [];
	const options = (spec.map ?? {})[String(current)];
	return Array.isArray(options) ? options : [];
}

/**
 * One entry per `optionsBy` field holding a value its sibling does not allow.
 *
 * The routing form's thinking levels are family-specific (`minimal` is pi-only,
 * `ultracode` claude-only), so switching a route's provider can strand a level
 * the target runtime would clamp away without saying so. Catching it here means
 * the form refuses to write a config that loadRoutingConfig would reject at the
 * next preflight, instead of the user finding out one run later.
 *
 * A RUNTIME-sourced list (`optionsBy.source`, i.e. the models a daemon
 * reported) is skipped: a value missing from it is routinely legitimate — a
 * brand-new model id, or a daemon that was down when the form loaded — and the
 * control already degrades to a text box in that case. Only the static tables
 * the schema itself declares are enforced here.
 */
export function dependentOptionProblems(schema, doc, prefix = []) {
	const problems = [];
	eachField(schema, doc, prefix, (field, base) => {
		if (!field.optionsBy || field.optionsBy.source !== undefined) return;
		const value = getPath(doc, fieldPath(base, field.path));
		const on = getPath(doc, fieldPath(base, field.optionsBy.path));
		// Same resolver the control paints from: what the form refuses to save
		// must be exactly what it refused to offer.
		const allowed = dependentOptions(field.optionsBy, doc, base);
		// A multi-value field (`flags`) holds an ARRAY, so membership has to be
		// checked per element: testing the array itself never matches and would
		// report every seat's capability list as invalid.
		const offending = Array.isArray(value)
			? value.filter((entry) => !allowed.includes(entry))
			: value !== undefined && value !== null && value !== "" && !allowed.includes(value)
				? [value]
				: [];
		if (allowed.length > 0 && offending.length > 0) {
			problems.push(
				`${base.length > 0 ? displayPath(base) : field.path}: ${field.label} "${offending.join(", ")}" không hợp lệ với ${on} (chỉ nhận: ${allowed.join(", ")})`,
			);
		}
	});
	return problems;
}

/**
 * One entry per OPTIONAL map key that is present but not filled in.
 *
 * A map's `optionalKeys` (the routing forms' SUPERVISOR_GOVERNANCE and
 * LEAD_RECOVERY) may be absent — absent is a valid route file. Half-filled is
 * not: picking a provider and saving would write a route with no model, which
 * loadRoutingConfig rejects, and a route file that does not load makes the
 * create_agent gate refuse EVERY seating, not just the one this class serves.
 * So an optional entry is either complete or removed before save.
 */
export function optionalEntryProblems(schema, doc, prefix = []) {
	const problems = [];
	eachField(schema, doc, prefix, (field, base) => {
		if (field.type !== "map" || !field.item) return;
		const object = getPath(doc, fieldPath(base, field.path)) ?? {};
		for (const key of field.optionalKeys ?? []) {
			const entry = pruneEmpty(object[key]);
			if (entry === undefined) continue;
			const missing = (field.item.fields ?? [])
				.filter((child) => {
					const value = getPath(entry, fieldPath([], child.path));
					return value === undefined || value === null || value === "";
				})
				.map((child) => child.label ?? child.path);
			if (missing.length > 0) {
				problems.push(`${key}: lớp tuỳ chọn chưa điền đủ (thiếu ${missing.join(", ")}) — điền đủ hoặc bấm "Bỏ cấu hình"`);
			}
		}
	});
	return problems;
}

/** Split a textarea into argv-style lines: trimmed, blanks dropped. */
export function parseLines(text) {
	return String(text ?? "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

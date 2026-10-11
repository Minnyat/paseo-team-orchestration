/**
 * config-form.js — pure helpers for the schema-driven config editor.
 *
 * No DOM here on purpose: every function is plain data-in/data-out so the
 * merge semantics (a save may never drop a key the form does not know about)
 * are testable from Node like any other contract.
 */

export function clone(value) {
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function getPath(root, path) {
	let node = root;
	for (const part of path.split(".")) {
		if (node === null || typeof node !== "object") return undefined;
		node = node[part];
	}
	return node;
}

export function setPath(root, path, value) {
	const parts = path.split(".");
	let node = root;
	for (const part of parts.slice(0, -1)) {
		if (typeof node[part] !== "object" || node[part] === null) node[part] = {};
		node = node[part];
	}
	node[parts[parts.length - 1]] = value;
}

/** Delete a leaf and any now-empty parents, so a reset field leaves no `"retry": {}` husk. */
export function deletePath(root, path) {
	if (typeof root !== "object" || root === null) return;
	deleteRec(root, path.split("."));

	function deleteRec(node, parts) {
		if (parts.length === 1) {
			delete node[parts[0]];
			return;
		}
		const child = node[parts[0]];
		if (typeof child !== "object" || child === null) return;
		deleteRec(child, parts.slice(1));
		if (Object.keys(child).length === 0) delete node[parts[0]];
	}
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
 */
export function pruneEmpty(value) {
	if (Array.isArray(value)) return value.length > 0 ? value : undefined;
	if (value !== null && typeof value === "object") {
		const out = {};
		for (const [key, child] of Object.entries(value)) {
			const kept = pruneEmpty(child);
			if (kept !== undefined) out[key] = kept;
		}
		return Object.keys(out).length > 0 ? out : undefined;
	}
	return value;
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
	for (const group of schema?.groups ?? []) {
		for (const field of group.fields ?? []) visit(field, "");
	}
	function visit(field, base) {
		const path = base ? `${base}.${field.path}` : field.path;
		if (field.keepEmpty && getPath(doc, path) === undefined) setPath(doc, path, []);
		if (field.type === "map" && field.item) {
			const object = getPath(doc, path);
			for (const key of Object.keys(object ?? {})) {
				for (const child of field.item.fields ?? []) visit(child, `${path}.${key}`);
			}
		}
	}
	return doc;
}

/** One entry per number field outside its range, with the label to show the user. */
export function numberRangeProblems(schema, doc, prefix = "") {
	const problems = [];
	for (const group of schema?.groups ?? []) {
		for (const field of group.fields ?? []) collectField(field, prefix);
	}
	function collectField(field, base) {
		const path = base ? `${base}.${field.path}` : field.path;
		if (field.type === "number") {
			const value = getPath(doc, path);
			if (value !== undefined && value !== null && value !== "") {
				const numeric = Number(value);
				if (!Number.isFinite(numeric) || numeric < (field.min ?? -Infinity) || numeric > (field.max ?? Infinity)) {
					problems.push(`${field.label} phải là số từ ${field.min ?? "−∞"} đến ${field.max ?? "∞"}`);
				}
			}
		}
		if (field.type === "map" && field.item) {
			const object = getPath(doc, path);
			for (const key of Object.keys(object ?? {})) {
				for (const child of field.item.fields ?? []) collectField(child, `${path}.${key}`);
			}
		}
	}
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
 * `prefix` is the path of the item the field lives in ("routes.REVIEW_HIGH"),
 * or "" for a top-level field.
 */
export function dependentOptions(spec, doc, prefix = "") {
	if (spec === null || typeof spec !== "object") return null;
	const current = getPath(doc, prefix ? `${prefix}.${spec.path}` : spec.path);
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
export function dependentOptionProblems(schema, doc, prefix = "") {
	const problems = [];
	for (const group of schema?.groups ?? []) {
		for (const field of group.fields ?? []) collectField(field, prefix);
	}
	function collectField(field, base) {
		const path = base ? `${base}.${field.path}` : field.path;
		if (field.optionsBy && field.optionsBy.source === undefined) {
			const value = getPath(doc, path);
			const on = getPath(doc, base ? `${base}.${field.optionsBy.path}` : field.optionsBy.path);
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
					`${base || field.path}: ${field.label} "${offending.join(", ")}" không hợp lệ với ${on} (chỉ nhận: ${allowed.join(", ")})`,
				);
			}
		}
		if (field.type === "map" && field.item) {
			const object = getPath(doc, path);
			for (const key of Object.keys(object ?? {})) {
				for (const child of field.item.fields ?? []) collectField(child, `${path}.${key}`);
			}
		}
	}
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
export function optionalEntryProblems(schema, doc, prefix = "") {
	const problems = [];
	for (const group of schema?.groups ?? []) {
		for (const field of group.fields ?? []) collectField(field, prefix);
	}
	function collectField(field, base) {
		const path = base ? `${base}.${field.path}` : field.path;
		if (field.type !== "map" || !field.item) return;
		const object = getPath(doc, path) ?? {};
		for (const key of field.optionalKeys ?? []) {
			const entry = pruneEmpty(object[key]);
			if (entry === undefined) continue;
			const missing = (field.item.fields ?? [])
				.filter((child) => {
					const value = getPath(entry, child.path);
					return value === undefined || value === null || value === "";
				})
				.map((child) => child.label ?? child.path);
			if (missing.length > 0) {
				problems.push(`${key}: lớp tuỳ chọn chưa điền đủ (thiếu ${missing.join(", ")}) — điền đủ hoặc bấm "Bỏ cấu hình"`);
			}
		}
		for (const key of Object.keys(object)) {
			for (const child of field.item.fields ?? []) collectField(child, `${path}.${key}`);
		}
	}
	return problems;
}

/** Split a textarea into argv-style lines: trimmed, blanks dropped. */
export function parseLines(text) {
	return String(text ?? "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

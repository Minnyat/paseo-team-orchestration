// daemon-target.mjs — the 0.10+ half of the fake SDK: the real module picks
// instance-vs-endpoint from --home/--host and PASEO_HOME/PASEO_HOST; this one
// only has to be shape-compatible, and always answers "local instance".

export function selectDaemonTarget(options = {}, env = process.env) {
	if (options.host !== undefined) return { kind: "endpoint", host: String(options.host) };
	return { kind: "instance", home: env.PASEO_HOME ?? "/fake/paseo-home" };
}

export function describeDaemonTarget(target) {
	return target.kind === "instance" ? `home ${target.home}` : String(target.host);
}

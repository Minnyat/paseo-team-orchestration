// fake-paseo-client-0.10/ — a client SDK shaped like Paseo 0.10+.
//
// `models refresh` imports the daemon-target module from the SAME directory as
// the client module and, when the SDK ships one, passes connectToDaemon a
// `target` (0.10 made that field mandatory: connectToDaemon({timeout}) alone
// now dies on `options.target.kind`). The connect call is still logged by the
// original fake, so a test can assert the target actually reached it.

export { connectToDaemon } from "../fake-paseo-client.mjs";

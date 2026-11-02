#!/usr/bin/env bash
# multihost-lab.sh — dựng một cụm N "máy" Paseo trên MỘT máy thật để thử
# multi-host / multi-project end to end, không cần máy thứ hai và không cần
# API key của model.
#
# Mỗi "máy" là một HOME riêng (=> ~/.paseo, ~/.paseo-team-orchestration,
# ~/.pi, ~/.claude riêng) với daemon nghe trên một cổng TCP riêng. Host đầu
# tiên là controller (connection.type "local"); các host còn lại là remote,
# endpoint đặt trong env PASEO_LAB_<HOST> (file cluster chỉ chứa TÊN env).
#
# Provider vai trò (pi-peer, claude-peer, opencode-peer, ...) ở lab "extends"
# provider `mock` có sẵn của Paseo, nên `remote-paseo.mjs run` thực sự tạo
# agent, chạy, inspect, stop, archive trên daemon đích — chỉ là model giả.
#
# Thêm cho giống máy thật:
#   --bind <ip>      remote host nghe trên IP này (mặc định 127.0.0.1; dùng IP
#                    card mạng thật, ví dụ `hostname -I`, để đi qua mạng thật)
#   --secure <id>    host này bật mật khẩu daemon (hash bcrypt trong config —
#                    PASEO_PASSWORD qua `daemon start` KHÔNG có tác dụng, đã đo);
#                    endpoint của nó mang ?password=. Mặc định: host cuối; "none" tắt.
#   Một bare repo chung ($ROOT/shared.git) — mỗi host clone nó vào projects/demo,
#   nên chuỗi Engineer push → Reviewer clone đúng SHA chạy được xuyên host.
#   Remote host được đăng ký vào registry gốc của daemon controller
#   (`paseo host add --label <id> --meta team.host-id=<id>`), để thử đường MCP
#   `serverId` của Paseo 0.14.
#
# Usage:
#   scripts/lab/multihost-lab.sh up   [--hosts a,b,c] [--base-port 6801] [--root DIR] [--bind IP] [--secure ID|none]
#   scripts/lab/multihost-lab.sh env  [--root DIR]      # in ra các lệnh export
#   scripts/lab/multihost-lab.sh test [--root DIR]      # chạy scenario tự động
#   scripts/lab/multihost-lab.sh down [--root DIR]
#
# Mặc định ROOT=${TMPDIR:-/tmp}/paseo-lab. Không đụng HOME thật của bạn.
set -euo pipefail

PACK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CMD="${1:-}"; shift || true
HOSTS="lab-a,lab-b,lab-c"
BASE_PORT=6801
ROOT="${PASEO_LAB_ROOT:-${TMPDIR:-/tmp}/paseo-lab}"
BIND=127.0.0.1
SECURE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --bind) BIND="$2"; shift 2 ;;
    --secure) SECURE="$2"; shift 2 ;;
    --hosts) HOSTS="$2"; shift 2 ;;
    --base-port) BASE_PORT="$2"; shift 2 ;;
    --root) ROOT="$2"; shift 2 ;;
    *) echo "[lab] unknown argument: $1" >&2; exit 1 ;;
  esac
done

command -v paseo >/dev/null || { echo "[lab] paseo CLI not found: npm i -g @getpaseo/cli" >&2; exit 1; }
IFS=',' read -r -a HOST_IDS <<<"$HOSTS"

env_name() { local up; up=$(echo "$1" | tr '[:lower:]-' '[:upper:]_'); echo "PASEO_LAB_${up}"; }
host_home() { echo "$ROOT/$1"; }

write_paseo_config() { # $1 home $2 listen $3 host-id $4 password-or-empty
  mkdir -p "$1/.paseo"
  node - "$1/.paseo/config.json" "$2" "$PACK_ROOT" "$3" "${4:-}" <<'NODE'
const [file, listen, packRoot, hostId, password] = process.argv.slice(2);
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
(async () => {
  const { RUNTIME_FAMILIES, runtimeDescriptor } = await import(pathToFileURL(`${packRoot}/scripts/model-routing.mjs`).href);
  const providers = {};
  for (const family of RUNTIME_FAMILIES) for (const role of runtimeDescriptor(family).roles) {
    // Paseo only lets a custom provider extend a real runtime or "acp"; the
    // lab's fake ACP agent stands in for every family's coding agent.
    providers[`${family}-${role}`] = {
      extends: "acp",
      label: `LAB ${family}-${role} (fake ACP)`,
      command: [process.execPath, `${packRoot}/scripts/lab/fake-acp-agent.mjs`],
      env: { PASEO_PI_ROLE: role, PASEO_LAB_HOST_ID: hostId, PASEO_LAB_FAMILY: family,
             PASEO_LAB_MODEL_ID: runtimeDescriptor(family).model.carriesProvider ? "lab/lab-model" : "lab-model" },
    };
  }
  const cfg = {
    version: 1,
    daemon: { listen, relay: { enabled: false }, mcp: { enabled: true, injectIntoAgents: true } },
    agents: { providers },
  };
  if (password) {
    // bcryptjs ships inside @getpaseo/server; the daemon compares against it.
    const { execSync } = require("node:child_process");
    const root = execSync("npm root -g", { encoding: "utf8" }).trim();
    const bcrypt = require(execSync(`find ${root}/@getpaseo -type d -name bcryptjs -print -quit`, { encoding: "utf8" }).trim());
    cfg.daemon.auth = { password: bcrypt.hashSync(password, 10) };
  }
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
})();
NODE
}

write_cluster() { # controller home
  local home="$1"; local dir="$home/.paseo-team-orchestration"; mkdir -p "$dir"
  node - "$dir/cluster-routing.local.json" "$PACK_ROOT" "${HOST_IDS[@]}" <<'NODE'
const [file, packRoot, ...hosts] = process.argv.slice(2);
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
(async () => {
  const { RUNTIME_FAMILIES, runtimeDescriptor } = await import(pathToFileURL(`${packRoot}/scripts/model-routing.mjs`).href);
  // Rotate the runtime family per host so the lab exercises "N hosts with
  // DIFFERENT model mappings" and every registered family at least once.
  // The fake ACP agent advertises "lab/lab-model" to provider-carrying
  // families (pi) and "lab-model" to bare-id ones, with no thinking options —
  // so every route runs at "off", the one level a modelless option accepts.
  const model = (fam) => runtimeDescriptor(fam).model.carriesProvider ? "lab/lab-model" : "lab-model";
  const route = (fam, role) => ({ paseoProvider: `${fam}-${role}`, model: model(fam), thinking: "off" });
  const out = { version: 1, hosts: {} };
  hosts.forEach((id, i) => {
    const fam = RUNTIME_FAMILIES[i % RUNTIME_FAMILIES.length];
    // Supervisor classes need a family that carries the role (a Peer-only
    // runtime such as opencode cannot); use the first one that does.
    const supFam = runtimeDescriptor(fam).roles.includes("supervisor")
      ? fam : RUNTIME_FAMILIES.find((f) => runtimeDescriptor(f).roles.includes("supervisor"));
    const local = i === 0;
    out.hosts[id] = {
      connection: local ? { type: "local" } : { type: "remote", endpointEnv: `PASEO_LAB_${id.toUpperCase().replace(/-/g, "_")}` },
      required: true,
      capabilities: local ? ["git-read", "git-write", "focused-test"] : ["git-read", "focused-test", "independent-review"],
      limits: { writers: local ? 1 : 0, readers: 2 },
      routes: {
        MONITOR_ECONOMY: route(supFam, "supervisor"),
        FAST_READ: route(fam, "peer"),
        CODING_MEDIUM: route(fam, "peer"),
        REASONING_HIGH: route(fam, "peer"),
        REVIEW_HIGH: route(fam, "peer"),
      },
    };
  });
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  // Each host also gets its OWN model-routing.local.json (same routes, its
  // own hostId) — that is the file every host's create_agent gate reads.
  const path = require("node:path");
  const root = path.dirname(path.dirname(path.dirname(file)));
  for (const [id, host] of Object.entries(out.hosts)) {
    const dir = path.join(root, id, ".paseo-team-orchestration");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "model-routing.local.json"),
      JSON.stringify({ version: 1, hostId: id, routes: host.routes }, null, 2) + "\n");
  }
})();
NODE
}

print_env() {
  cat "$ROOT/endpoints"
  echo "export HOME=$(host_home "${HOST_IDS[0]}")   # controller = ${HOST_IDS[0]}"
}

case "$CMD" in
  up)
    mkdir -p "$ROOT"
    [[ -n "$SECURE" ]] || SECURE="${HOST_IDS[${#HOST_IDS[@]}-1]}"
    printf '%s\n' "$HOSTS" >"$ROOT/hosts"; printf '%s\n' "$BASE_PORT" >"$ROOT/base-port"
    : >"$ROOT/endpoints"
    # The shared remote every host clones: the only anchor between a writer
    # on one host and a reviewer on another is a pushed SHA.
    if [[ ! -d "$ROOT/shared.git" ]]; then
      git init -q --bare -b main "$ROOT/shared.git"
      seed=$(mktemp -d); git -C "$seed" init -q -b main
      echo "# shared demo" >"$seed/README.md"
      git -C "$seed" -c user.email=lab@local -c user.name=lab add -A
      git -C "$seed" -c user.email=lab@local -c user.name=lab commit -qm init
      git -C "$seed" push -q "$ROOT/shared.git" main; rm -rf "$seed"
    fi
    i=0
    for id in "${HOST_IDS[@]}"; do
      home=$(host_home "$id"); port=$((BASE_PORT + i))
      addr=127.0.0.1; [[ $i -gt 0 ]] && addr="$BIND"
      pw=""; [[ "$id" == "$SECURE" ]] && pw="lab-pw-$id"
      write_paseo_config "$home" "$addr:$port" "$id" "$pw"
      if [[ ! -d "$home/projects/demo/.git" ]]; then
        mkdir -p "$home/projects"
        git clone -q "$ROOT/shared.git" "$home/projects/demo"
        git -C "$home/projects/demo" config user.email "lab@$id"; git -C "$home/projects/demo" config user.name "lab-$id"
      fi
      HOME="$home" paseo daemon start --json >/dev/null
      if [[ $i -gt 0 ]]; then
        endpoint="tcp://$addr:$port"; [[ -n "$pw" ]] && endpoint="$endpoint?password=$pw"
        echo "export $(env_name "$id")='$endpoint'" >>"$ROOT/endpoints"
      fi
      echo "[lab] $id  HOME=$home  listen=$addr:$port${pw:+  (password)}"
      i=$((i + 1))
    done
    write_cluster "$(host_home "${HOST_IDS[0]}")"
    # Native Paseo host registry on the controller (idempotent by label).
    ctl=$(host_home "${HOST_IDS[0]}")
    eval "$(cat "$ROOT/endpoints")"
    for id in "${HOST_IDS[@]:1}"; do
      var=$(env_name "$id")
      if ! HOME="$ctl" paseo host ls --json | grep -q "\"label\": \"$id\""; then
        HOME="$ctl" paseo host add "${!var}" --label "$id" --meta "team.host-id=$id" --json >/dev/null
      fi
    done
    echo "[lab] cluster file -> $ctl/.paseo-team-orchestration/cluster-routing.local.json"
    echo "[lab] eval \"\$($0 env --root $ROOT)\"  to act as the controller"
    ;;
  env)
    HOSTS=$(cat "$ROOT/hosts"); BASE_PORT=$(cat "$ROOT/base-port"); IFS=',' read -r -a HOST_IDS <<<"$HOSTS"
    print_env ;;
  test)
    HOSTS=$(cat "$ROOT/hosts"); BASE_PORT=$(cat "$ROOT/base-port"); IFS=',' read -r -a HOST_IDS <<<"$HOSTS"
    eval "$(print_env)"
    node "$PACK_ROOT/scripts/lab/multihost-scenario.mjs" "$ROOT" "${HOST_IDS[@]}"
    exec node "$PACK_ROOT/scripts/lab/multihost-deep.mjs" "$ROOT" "${HOST_IDS[@]}" ;;
  down)
    HOSTS=$(cat "$ROOT/hosts" 2>/dev/null || echo "$HOSTS"); IFS=',' read -r -a HOST_IDS <<<"$HOSTS"
    for id in "${HOST_IDS[@]}"; do HOME=$(host_home "$id") paseo daemon stop >/dev/null 2>&1 || true; echo "[lab] stopped $id"; done ;;
  *) sed -n '2,21p' "$0"; exit 1 ;;
esac

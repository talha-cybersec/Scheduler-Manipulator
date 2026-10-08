import { useState, useEffect, useRef, useCallback } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from "recharts";

const WS_URL = "ws://localhost:5000/ws";

export default function App() {
  const ws = useRef(null);
  const [connected, setConnected] = useState(false);
  const [mode, setMode] = useState("observe");
  const [processes, setProcesses] = useState([]);
  const [throughput, setThroughput] = useState({});
  const [workerPids, setWorkerPids] = useState({});
  const [history, setHistory] = useState([]);
  const [log, setLog] = useState([]);
  const [inversionLog, setInversionLog] = useState([]);
  const [demoRunning, setDemoRunning] = useState(false);

  const addLog = useCallback((text, isError = false) => setLog(l => [
    { text: `[${new Date().toLocaleTimeString()}] ${text}`, isError }, ...l.slice(0, 19)
  ]), []);

  useEffect(() => {
    const socket = new WebSocket(WS_URL);
    ws.current = socket;

    socket.onopen = () => {
      setConnected(true);
      addLog("Connected to backend");
    };

    socket.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.event === "stats") {
        setProcesses(msg.processes || []);
        setThroughput(msg.throughput || {});
        setWorkerPids(msg.worker_pids || {});
        setHistory(h => [...h.slice(-30), {
          time: new Date().toLocaleTimeString(),
          ...msg.throughput
        }]);
      } else if (msg.event === "spawned") {
        addLog(`Spawned worker "${msg.name}" with PID ${msg.pid}`);
      } else if (msg.event === "inversion_started") {
        setDemoRunning(true);
      } else if (msg.event === "inversion_log") {
        setInversionLog(l => [...l, msg.line]);
      } else if (msg.event === "inversion_done") {
        setDemoRunning(false);
        setInversionLog(l => [...l, msg.code === 0 ? "--- DEMO COMPLETE ---" : "--- DEMO FAILED ---"]);
      } else if (msg.event === "ok") {
        addLog(`✔ ${msg.action} applied to PID ${msg.pid}${msg.detail ? " (" + msg.detail + ")" : ""}`);
      } else if (msg.event === "error") {
        addLog(`✖ ${msg.action} FAILED on PID ${msg.pid}: ${msg.detail}`, true);
      } else if (msg.event === "killed") {
        addLog(`Worker "${msg.name}" killed`);
      }
    };

    socket.onclose = () => setConnected(false);

    const interval = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ action: "get_stats" }));
    }, 500);

    return () => { clearInterval(interval); socket.close(); };
  }, [addLog]);

  const send = (msg) => {
    if (ws.current?.readyState === WebSocket.OPEN)
      ws.current.send(JSON.stringify(msg));
  };

  const spawnWorker = (name, core) =>
    send(core === undefined ? { action: "spawn_worker", name } : { action: "spawn_worker", name, core });
  const killWorker = (name) => send({ action: "kill_worker", name });
  const runDemo = (inherit) => { setInversionLog([]); send({ action: "inversion_demo", inherit }); };

  // PID -> worker name, so the table can show each worker's own throughput
  const nameByPid = Object.fromEntries(Object.entries(workerPids).map(([n, pid]) => [pid, n]));
  const runningWorkers = ["workerA", "workerB"].filter(n => workerPids[n]);

  const styles = {
    app:    { fontFamily: "monospace", background: "#0d1117", color: "#e6edf3",
              minHeight: "100vh", padding: "1.5rem", boxSizing: "border-box" },
    header: { color: "#58a6ff", fontSize: "1.4rem", marginBottom: "0.3rem" },
    badge:  { display: "inline-block", padding: "2px 10px", borderRadius: "12px",
              fontSize: "0.75rem", marginLeft: "0.7rem",
              background: connected ? "#1a4a1a" : "#4a1a1a",
              color: connected ? "#3fb950" : "#f85149" },
    card:   { background: "#161b22", border: "1px solid #30363d", borderRadius: "8px",
              padding: "1rem", marginBottom: "1rem" },
    hint:   { color: "#8b949e", fontSize: "0.78rem", marginTop: "0.5rem" },
    label:  { color: "#8b949e", fontSize: "0.8rem", marginBottom: "0.7rem" },
    btn:    (active, color = "#58a6ff") => ({
              padding: "6px 14px", borderRadius: "6px", border: "none",
              cursor: "pointer", fontFamily: "monospace", fontSize: "0.85rem",
              background: active ? color : "#21262d", color: active ? "#fff" : "#e6edf3",
              marginRight: "6px", marginBottom: "6px"
            }),
    table:  { width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" },
    th:     { padding: "6px 10px", borderBottom: "1px solid #30363d",
              textAlign: "left", color: "#8b949e" },
    td:     { padding: "6px 10px", borderBottom: "1px solid #21262d" },
  };

  const MODES = [
    { id: "observe",    label: "👁 Observe"   },
    { id: "inflate",    label: "🚀 Inflate"   },
    { id: "starve",     label: "💀 Starve"    },
    { id: "inversion",  label: "🪲 Inversion" },
    { id: "sidebyside", label: "⚖ Compare"   },
  ];

  const lineColor = (line) =>
      line.startsWith("HIGH")   ? "#f85149"
    : line.startsWith("MED")    ? "#d29922"
    : line.startsWith("LOW")    ? "#3fb950"
    : line.startsWith("RESULT") ? "#58a6ff"
    : line.startsWith("ERROR")  ? "#f85149"
    : "#8b949e";

  return (
    <div style={styles.app}>
      <h1 style={styles.header}>
        ⚙ Scheduler Manipulator
        <span style={styles.badge}>{connected ? "CONNECTED" : "DISCONNECTED"}</span>
      </h1>
      <p style={{ color: "#8b949e", marginBottom: "1rem", fontSize: "0.85rem" }}>
        Real-time Linux kernel scheduler manipulation
      </p>

      <div style={styles.card}>
        <div style={styles.label}>SELECT MODE</div>
        {MODES.map(m => (
          <button key={m.id} style={styles.btn(mode === m.id, "#58a6ff")}
                  onClick={() => setMode(m.id)}>{m.label}</button>
        ))}
      </div>

      {["observe", "inflate", "starve"].includes(mode) && (
        <div style={styles.card}>
          <div style={styles.label}>WORKERS</div>
          <button style={styles.btn(false, "#238636")} onClick={() => spawnWorker("workerA")}>+ Spawn Worker A</button>
          <button style={styles.btn(false, "#238636")} onClick={() => spawnWorker("workerB")}>+ Spawn Worker B</button>
          <button style={styles.btn(false, "#da3633")} onClick={() => killWorker("workerA")}>Kill A</button>
          <button style={styles.btn(false, "#da3633")} onClick={() => killWorker("workerB")}>Kill B</button>

          {mode === "inflate" && (
            <div style={{ marginTop: "0.7rem" }}>
              <div style={styles.label}>INFLATE: give a worker more CPU priority (renice to nice -15)</div>
              {runningWorkers.map(name => (
                <button key={name} style={styles.btn(false, "#8957e5")}
                        onClick={() => send({ action: "inflate", pid: workerPids[name], nice: -15 })}>
                  🚀 Inflate {name} (PID {workerPids[name]})
                </button>
              ))}
              {runningWorkers.map(name => (
                <button key={name + "r"} style={styles.btn(false, "#8b949e")}
                        onClick={() => send({ action: "restore", pid: workerPids[name] })}>
                  Restore {name}
                </button>
              ))}
              <div style={styles.hint}>
                Watch the Nice column change. A higher priority only raises throughput when workers
                compete for the same core: use Starve to pin both to core 0, or Compare mode.
              </div>
            </div>
          )}

          {mode === "starve" && (
            <div style={{ marginTop: "0.7rem" }}>
              <div style={styles.label}>STARVE: pin workers to core 0 (taskset) so they fight over one CPU</div>
              {runningWorkers.map(name => (
                <button key={name} style={styles.btn(false, "#d29922")}
                        onClick={() => send({ action: "starve", pid: workerPids[name], core: 0 })}>
                  💀 Pin {name} to core 0
                </button>
              ))}
              {runningWorkers.map(name => (
                <button key={name + "r"} style={styles.btn(false, "#8b949e")}
                        onClick={() => send({ action: "restore", pid: workerPids[name] })}>
                  Restore {name}
                </button>
              ))}
              <div style={styles.hint}>
                Pin both workers: each gets about half of core 0 and its throughput drops, even though
                the other cores are idle.
              </div>
            </div>
          )}
        </div>
      )}

      {mode === "inversion" && (
        <div style={styles.card}>
          <div style={styles.label}>🪲 PRIORITY INVERSION DEMO: recreates the Mars Pathfinder bug</div>
          <button style={styles.btn(false, "#da3633")} disabled={demoRunning}
                  onClick={() => runDemo(false)}>
            ▶ Run inversion
          </button>
          <button style={styles.btn(false, "#238636")} disabled={demoRunning}
                  onClick={() => runDemo(true)}>
            ▶ Run with priority inheritance (the fix)
          </button>
          <div style={{ marginTop: "1rem", background: "#0d1117", borderRadius: "6px",
                        padding: "0.7rem", minHeight: "120px", fontSize: "0.8rem" }}>
            {inversionLog.length === 0
              ? <span style={{ color: "#8b949e" }}>Press Run to start. Watch the thread order...</span>
              : inversionLog.map((line, i) => (
                  <div key={i} style={{ color: lineColor(line),
                                        fontWeight: line.startsWith("RESULT") ? "bold" : "normal" }}>
                    {line}
                  </div>
                ))
            }
          </div>
          <div style={styles.hint}>
            Three SCHED_FIFO threads share core 0. Without inheritance, MED (priority 20) preempts LOW
            (priority 10) while LOW holds the mutex, so HIGH (priority 30) waits for MED. With
            inheritance, LOW is boosted to HIGH's priority and HIGH gets the mutex much sooner.
          </div>
        </div>
      )}

      {mode === "sidebyside" && (
        <div style={styles.card}>
          <div style={styles.label}>⚖ SIDE BY SIDE: same workload on the same core, one manipulated</div>
          <button style={styles.btn(false, "#238636")} onClick={() => {
            spawnWorker("normal", 0); spawnWorker("boosted", 0);
          }}>+ Spawn both workers on core 0</button>
          {workerPids["boosted"] && (
            <button style={styles.btn(false, "#8957e5")}
                    onClick={() => send({ action: "inflate", pid: workerPids["boosted"], nice: -19 })}>
              🚀 Boost "boosted" to nice -19
            </button>
          )}
          {workerPids["boosted"] && (
            <button style={styles.btn(false, "#8b949e")}
                    onClick={() => send({ action: "inflate", pid: workerPids["boosted"], nice: 0 })}>
              Reset "boosted" to nice 0
            </button>
          )}
          {(workerPids["normal"] || workerPids["boosted"]) && (
            <button style={styles.btn(false, "#da3633")}
                    onClick={() => { killWorker("normal"); killWorker("boosted"); }}>
              Kill both
            </button>
          )}
          <div style={{ marginTop: "1rem", height: "220px" }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={history}>
                <XAxis dataKey="time" tick={{ fontSize: 10, fill: "#8b949e" }} />
                <YAxis tick={{ fontSize: 10, fill: "#8b949e" }} />
                <Tooltip contentStyle={{ background: "#161b22", border: "1px solid #30363d" }} />
                <Legend />
                <Line type="monotone" dataKey="normal"  stroke="#3fb950" dot={false} strokeWidth={2} isAnimationActive={false} />
                <Line type="monotone" dataKey="boosted" stroke="#8957e5" dot={false} strokeWidth={2} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div style={styles.hint}>Throughput in blocks/second. Both lines start level; after the boost they split apart.</div>
        </div>
      )}

      <div style={styles.card}>
        <div style={styles.label}>
          LIVE PROCESS VIEW {Object.keys(workerPids).length ? "(spawned workers)" : "(top 20 processes by CPU)"}
        </div>
        <table style={styles.table}>
          <thead>
            <tr>{["PID", "Name", "Nice", "CPU%", "Cores", "Status", "Throughput"].map(h => (
              <th key={h} style={styles.th}>{h}</th>
            ))}</tr>
          </thead>
          <tbody>
            {[...processes].sort((a, b) => (b.cpu_percent || 0) - (a.cpu_percent || 0)).slice(0, 20).map(p => {
              const worker = nameByPid[p.pid];
              return (
                <tr key={p.pid}>
                  <td style={styles.td}>{p.pid}</td>
                  <td style={styles.td}>{worker ? `${p.name} (${worker})` : p.name}</td>
                  <td style={{ ...styles.td,
                    color: p.nice < 0 ? "#f85149" : p.nice > 0 ? "#3fb950" : "#e6edf3"
                  }}>{p.nice}</td>
                  <td style={styles.td}>{(p.cpu_percent || 0).toFixed(1)}%</td>
                  <td style={styles.td}>{p.cpu_affinity ? p.cpu_affinity.join(",") : "—"}</td>
                  <td style={styles.td}>{p.status}</td>
                  <td style={styles.td}>
                    {worker && throughput[worker] ? `${throughput[worker].toFixed(1)} blocks/s` : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={styles.card}>
        <div style={{ ...styles.label, marginBottom: "0.5rem" }}>EVENT LOG</div>
        {log.map((l, i) => (
          <div key={i} style={{ fontSize: "0.78rem", lineHeight: "1.6",
                                color: l.isError ? "#f85149" : "#8b949e" }}>{l.text}</div>
        ))}
      </div>
    </div>
  );
}

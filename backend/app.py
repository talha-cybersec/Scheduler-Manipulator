"""
Scheduler Manipulator - backend

Flask + flask-sock WebSocket server on ws://127.0.0.1:5000/ws.
The React dashboard sends JSON commands; this server starts the C programs,
applies scheduler changes through SchedulerManipulator, and streams live
process data and logs back.
"""
import json
import os
import subprocess
import threading

from flask import Flask
from flask_sock import Sock

from scheduler import SchedulerManipulator

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
C_DIR = os.path.join(BASE_DIR, "..", "c")
WORKER_BIN = os.path.join(C_DIR, "worker")
MUTEX_DEMO_BIN = os.path.join(C_DIR, "mutex_demo")

# Only listen on this machine by default: the backend can change the priority
# of any process, so it must not be reachable from the network.
HOST = os.environ.get("SM_HOST", "127.0.0.1")
PORT = int(os.environ.get("SM_PORT", "5000"))

app = Flask(__name__)
sock = Sock(app)
manip = SchedulerManipulator()

worker_procs = {}   # name -> Popen
throughput = {}     # name -> latest blocks/second


def read_worker_output(name, proc):
    """Background thread: keep the latest throughput reported by a worker."""
    try:
        for line in proc.stdout:
            parts = line.decode().strip().split()
            if len(parts) == 2:
                throughput[name] = float(parts[1])
    except (ValueError, OSError):
        pass


def stop_worker(name):
    proc = worker_procs.pop(name, None)
    throughput.pop(name, None)
    if proc and proc.poll() is None:
        proc.kill()
        proc.wait()


@sock.route('/ws')
def websocket(ws):
    send_lock = threading.Lock()

    def send(obj):
        # Several threads send on this socket (stats, demo log), so serialise.
        with send_lock:
            ws.send(json.dumps(obj))

    def result(action, pid, ok_msg):
        ok, msg = ok_msg
        if ok:
            send({'event': 'ok', 'action': action, 'pid': pid, 'detail': msg})
        else:
            send({'event': 'error', 'action': action, 'pid': pid,
                  'detail': msg or 'command failed (is the backend running as root?)'})

    try:
        while True:
            raw = ws.receive()
            if raw is None:
                break
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            action = msg.get('action')

            if action == 'spawn_worker':
                name = str(msg['name'])
                stop_worker(name)
                proc = subprocess.Popen([WORKER_BIN, name],
                                        stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL)
                worker_procs[name] = proc
                throughput[name] = 0.0
                threading.Thread(target=read_worker_output,
                                 args=(name, proc), daemon=True).start()
                send({'event': 'spawned', 'name': name, 'pid': proc.pid})
                # Optional: pin to one core straight away (used by Compare mode
                # so both workers compete for the same CPU).
                if 'core' in msg:
                    result('pin', proc.pid, manip.pin_to_core(proc.pid, int(msg['core'])))

            elif action == 'kill_worker':
                name = str(msg['name'])
                stop_worker(name)
                send({'event': 'killed', 'name': name})

            elif action == 'inflate':
                pid = int(msg['pid'])
                nice = int(msg.get('nice', -15))
                result('inflate', pid, manip.inflate_priority(pid, nice))

            elif action == 'starve':
                pid = int(msg['pid'])
                core = int(msg.get('core', 0))
                result('starve', pid, manip.pin_to_core(pid, core))

            elif action == 'restore':
                pid = int(msg['pid'])
                result('restore', pid, manip.restore_normal(pid))

            elif action == 'inversion_demo':
                old = worker_procs.get('inversion')
                if old and old.poll() is None:
                    continue    # a demo is already running
                cmd = [MUTEX_DEMO_BIN] + (['--inherit'] if msg.get('inherit') else [])
                proc = subprocess.Popen(manip.prefix + cmd,
                                        stdout=subprocess.PIPE,
                                        stderr=subprocess.STDOUT)
                worker_procs['inversion'] = proc
                send({'event': 'inversion_started', 'pid': proc.pid,
                      'inherit': bool(msg.get('inherit'))})

                def stream_output(p):
                    try:
                        for line in p.stdout:
                            send({'event': 'inversion_log', 'line': line.decode().strip()})
                        p.wait()
                        send({'event': 'inversion_done', 'code': p.returncode})
                    except Exception:
                        pass
                threading.Thread(target=stream_output, args=(proc,), daemon=True).start()

            elif action == 'get_stats':
                live = {name: p.pid for name, p in worker_procs.items()
                        if name != 'inversion' and p.poll() is None}
                stats = manip.get_process_stats(
                    filter_pids=list(live.values()) if live else None)
                send({'event': 'stats', 'processes': stats,
                      'throughput': throughput, 'worker_pids': live})

    except Exception as e:
        print(f"WS error: {e}")
    finally:
        # Dashboard closed or refreshed: don't leave CPU-burning workers behind.
        for name in list(worker_procs):
            stop_worker(name)


if __name__ == '__main__':
    app.run(host=HOST, port=PORT, debug=False)

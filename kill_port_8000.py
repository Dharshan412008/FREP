import subprocess
out = subprocess.check_output("netstat -aon", shell=True).decode('utf-8', errors='ignore')
pids = set()
for line in out.splitlines():
    if ":8000" in line:
        parts = line.split()
        if parts:
            pid = parts[-1]
            if pid.isdigit():
                pids.add(pid)
if not pids:
    print('No process listening on port 8000')
for pid in pids:
    try:
        subprocess.check_call(["taskkill", "/PID", pid, "/F"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        print('Stopped', pid)
    except subprocess.CalledProcessError as e:
        print('Failed to stop', pid, e)

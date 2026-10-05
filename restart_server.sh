#!/bin/bash
# zcode-phone-server 安全重启：等待会话空闲 -> 杀进程树 -> 重新拉起 -> 健康检查
# 端口/token 从 config.json 读取（脚本入库，不得硬编码访问令牌）
DIR="$(cd "$(dirname "$0")" && pwd)"
CFG="$DIR/config.json"
PORT=$(node -e "try{const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log(c.port||8787)}catch(e){console.log(8787)}" "$CFG" 2>/dev/null)
TOKEN=$(node -e "try{const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log(c.token||'')}catch(e){}" "$CFG" 2>/dev/null)
BASE="http://127.0.0.1:$PORT"
WATCH1="sess_5ba16212-df0d-47ee-b5a4-569b30caf905"   # 当前对话
WATCH2="sess_8a70132a-0b70-46d9-a770-5c02c3c44af5"   # 并行调试会话
MAX_WAIT=900   # 最长等 15 分钟，超时强制重启

busy_of() {
  curl -s --max-time 5 "$BASE/api/sessions?token=$TOKEN" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  try { const x=JSON.parse(s).sessions.find(y=>y.sessionId.startsWith('$1')); console.log(x?(x.busy?'busy':'idle'):'gone'); }
  catch { console.log('err'); }
});" 2>/dev/null
}

echo "$(date +%T) 等待会话空闲（当前对话 + 并行调试会话），最长 ${MAX_WAIT}s ..."
 waited=0
while [ $waited -lt $MAX_WAIT ]; do
  b1=$(busy_of "$WATCH1"); b2=$(busy_of "$WATCH2")
  if [ "$b1" = "idle" ] && [ "$b2" = "idle" ]; then
    sleep 3   # 缓冲：确认不是回合间隙
    b1=$(busy_of "$WATCH1"); b2=$(busy_of "$WATCH2")
    if [ "$b1" = "idle" ] && [ "$b2" = "idle" ]; then break; fi
  fi
  sleep 5; waited=$((waited+5))
  if [ $((waited % 30)) -eq 0 ]; then echo "$(date +%T) 仍在等待：$WATCH1=$b1 $WATCH2=$b2"; fi
done
[ $waited -ge $MAX_WAIT ] && echo "$(date +%T) 超时，强制重启"

# 找到 8787 监听进程并连子进程一起杀
PID=$(powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess" 2>/dev/null | tr -d '\r' | grep -E '^[0-9]+$' | head -1)
if [ -z "$PID" ]; then echo "$(date +%T) 未找到 8787 监听进程（可能已退出）"; else
  echo "$(date +%T) taskkill /T /F PID=$PID"
  taskkill //PID "$PID" //T //F 2>&1 | tail -3
  sleep 2
fi

# 重新拉起（隐藏窗口、独立于本脚本存活）
powershell -NoProfile -Command "Start-Process -FilePath 'node' -ArgumentList 'server.mjs' -WorkingDirectory '$DIR' -WindowStyle Hidden" 2>&1
echo "$(date +%T) 已拉起，等待健康检查 ..."

ok=""
for i in $(seq 1 30); do
  sleep 2
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$BASE/?token=$TOKEN" 2>/dev/null)
  if [ "$code" = "200" ]; then ok=yes; break; fi
done
if [ "$ok" = "yes" ]; then
  NEWPID=$(powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess" 2>/dev/null | tr -d '\r')
  echo "$(date +%T) 重启成功：HTTP 200，新 PID=$NEWPID"
  curl -s "$BASE/api/sessions?token=$TOKEN" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const l=JSON.parse(s).sessions;console.log('会话数:',l.length,'| 最近:',l.slice(0,2).map(x=>x.sessionId.slice(5,13)+':'+(x.busy?'busy':'idle')).join(', '))}catch(e){console.log('sessions 解析失败')}})"
else
  echo "$(date +%T) 重启后健康检查失败！请手动检查 start.bat"
  exit 1
fi

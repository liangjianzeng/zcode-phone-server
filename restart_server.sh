#!/bin/bash
# zcode-phone-server 安全重启：等待会话空闲 -> 杀进程树 -> 重新拉起 -> 健康检查
# 端口/token 从 config.json 读取（脚本入库，不得硬编码访问令牌）
#
# 两道实证教训（2026-11-13）：
#  1) 监听 PID 归属偶发失真（netstat/Get-NetTCPConnection 都返回 0）——taskkill 拿
#     PID=0 静默失败，旧进程活着，健康检查打旧进程返回 200 = 假"重启成功"。
#     对策：三通道找 PID（netstat>0 / Get-NetTCPConnection>0 / 按命令行找 server.mjs），
#     杀后验证端口真的放开，健康检查比对 /api/state 的 bootId 必须是新值。
#  2) 等空闲不能盯硬编码会话 id（会过期失效）：改为全部会话 busy 计数归零。
#  3) 项目自带守护 run-server.cmd（cmd :loop，端口空了 5s 内自动拉起 server.mjs）：
#     只杀 server 不杀守护 = 和守护对砍，每轮杀到的都是刚重生的新 PID，端口永不空
#     （2026-11-13 实测三轮全杀"新生儿"后误报失败）。顺序必须：杀守护树 -> 杀 server -> 经守护拉起。
DIR="$(cd "$(dirname "$0")" && pwd)"
CFG="$DIR/config.json"
PORT=$(node -e "try{const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log(c.port||8787)}catch(e){console.log(8787)}" "$CFG" 2>/dev/null)
TOKEN=$(node -e "try{const c=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log(c.token||'')}catch(e){}" "$CFG" 2>/dev/null)
BASE="http://127.0.0.1:$PORT"
MAX_WAIT=900   # 最长等 15 分钟，超时强制重启

busy_count() {   # 全部会话 busy 计数；查询失败/服务未起 = -1
  curl -s --max-time 5 "$BASE/api/sessions?token=$TOKEN" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  try { const l=JSON.parse(s).sessions||[]; console.log(l.filter(x=>x.busy).length); }
  catch { console.log(-1); }
});" 2>/dev/null
}

boot_id() {      # 当前应答进程的启动标识；查不到 = 空串
  curl -s --max-time 3 "$BASE/api/state?token=$TOKEN" | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  try { console.log(JSON.parse(s).bootId||''); } catch { console.log(''); }
});" 2>/dev/null
}

find_pids() {    # 监听进程 PID 列表（去重、剔 0）；三通道互补
  local pids
  pids=$(netstat -ano 2>/dev/null | grep -E "TCP +127\.0\.0\.1:$PORT +.*LISTENING" | awk '{print $NF}' | grep -E '^[1-9][0-9]*$')
  if [ -z "$pids" ]; then
    pids=$(powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue | Where-Object OwningProcess -gt 0 | Select-Object -ExpandProperty OwningProcess" 2>/dev/null | tr -d '\r' | grep -E '^[1-9][0-9]*$')
  fi
  if [ -z "$pids" ]; then
    # 兜底：按命令行找跑 server.mjs 的 node（今天实证：监听 PID 归属失真时这条最可靠）
    pids=$(powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { \$_.CommandLine -match 'server[.]mjs' } | Select-Object -ExpandProperty ProcessId" 2>/dev/null | tr -d '\r' | grep -E '^[1-9][0-9]*$')
  fi
  echo "$pids" | sort -u | grep -E '^[1-9][0-9]*$'
}

find_watchdogs() { # 守护实例（跑 run-server.cmd 的 cmd :loop）PID；不先杀它，server 秒级重生
  powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | Where-Object { \$_.CommandLine -match 'run-server[.]cmd' } | Select-Object -ExpandProperty ProcessId" 2>/dev/null | tr -d '\r' | grep -E '^[1-9][0-9]*$'
}

echo "$(date +%T) 等待全部会话空闲，最长 ${MAX_WAIT}s ..."
waited=0
while [ $waited -lt $MAX_WAIT ]; do
  n=$(busy_count)
  if [ "$n" = "0" ] || [ "$n" = "-1" ]; then   # -1 = 服务未起/查不到：不必再等
    sleep 3
    n=$(busy_count)
    if [ "$n" = "0" ] || [ "$n" = "-1" ]; then break; fi
  fi
  sleep 5; waited=$((waited+5))
  if [ $((waited % 30)) -eq 0 ]; then echo "$(date +%T) 仍在等待：$n 个会话 busy"; fi
done
[ $waited -ge $MAX_WAIT ] && echo "$(date +%T) 超时，强制重启"

OLD_BOOT=$(boot_id)

# 第一步：先杀守护树（taskkill /T 连带它当前拉着的 server 子进程一起）。
# 顺序不能反：守护活着时杀 server，它 5s 内就重生，杀循环永远见不到端口放开。
for round in 1 2 3; do
  wd=$(find_watchdogs)
  [ -z "$wd" ] && break
  echo "$(date +%T) 第 $round 轮杀守护 PID: $(echo $wd | tr '\n' ' ')"
  for pid in $wd; do
    taskkill //PID "$pid" //T //F >/dev/null 2>&1
  done
  sleep 2
done
if [ -n "$(find_watchdogs)" ]; then
  echo "$(date +%T) 失败：守护 run-server.cmd 杀不掉（PID: $(find_watchdogs | tr '\n' ' ')），拒绝带病重启；请手动排查"
  exit 1
fi

# 第二步：清扫残留 server（不受守护管辖的裸跑实例，如手工 Start-Process 拉起的）——
# 杀到端口真放开为止（3 轮 × 3s），杀不掉就失败退出，绝不带病"重启成功"
killed=no
for round in 1 2 3; do
  pids=$(find_pids)
  [ -z "$pids" ] && { killed=yes; break; }
  echo "$(date +%T) 第 $round 轮杀 server PID: $(echo $pids | tr '\n' ' ')"
  for pid in $pids; do
    taskkill //PID "$pid" //T //F >/dev/null 2>&1
  done
  sleep 3
done
if [ "$killed" != "yes" ]; then
  echo "$(date +%T) 失败：端口 $PORT 始终被占（PID: $(find_pids | tr '\n' ' ')），拒绝假重启；请手动排查"
  exit 1
fi

# 第三步：经守护拉起（连守护带服务一起恢复：server.mjs 由守护拉起、日志进 logs/；
# 直接裸拉 server.mjs 会让端口回到"裸跑无守护"状态）
DIR_WIN=$(cygpath -w "$DIR" 2>/dev/null || echo "$DIR")
powershell -NoProfile -Command "Start-Process -FilePath cmd.exe -ArgumentList '/c \"$DIR_WIN\\run-server.cmd\"' -WindowStyle Hidden" 2>&1
echo "$(date +%T) 已经守护拉起，等待健康检查（bootId 必须变化）..."

ok=""
for i in $(seq 1 30); do
  sleep 2
  NEW_BOOT=$(boot_id)
  if [ -n "$NEW_BOOT" ] && [ "$NEW_BOOT" != "$OLD_BOOT" ]; then ok=yes; break; fi
done
if [ "$ok" = "yes" ]; then
  NEWPID=$(find_pids | tr '\n' ' ')
  WDPID=$(find_watchdogs | tr '\n' ' ')
  echo "$(date +%T) 重启成功：bootId ${OLD_BOOT:0:8}… -> ${NEW_BOOT:0:8}…，PID=$NEWPID 守护=$WDPID"
  curl -s "$BASE/api/sessions?token=$TOKEN" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const l=JSON.parse(s).sessions;console.log('会话数:',l.length,'| 最近:',l.slice(0,2).map(x=>x.sessionId.slice(5,13)+':'+(x.busy?'busy':'idle')).join(', '))}catch(e){console.log('sessions 解析失败')}})"
else
  echo "$(date +%T) 重启后健康检查失败（bootId=${NEW_BOOT:-空}${OLD_BOOT:+，旧值 ${OLD_BOOT:0:8}…}）——旧进程可能未死或新进程秒退，请查 logs/"
  exit 1
fi

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Net.Http
[System.Windows.Forms.Application]::EnableVisualStyles()
$config = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'worker.json') -Raw | ConvertFrom-Json
$marker = Join-Path $PSScriptRoot 'data/ui-show'
$mutex = New-Object Threading.Mutex($false, "Local\HaohaochangTray$($config.port)")
if (!$mutex.WaitOne(0)) { New-Item -ItemType File -Path $marker -Force | Out-Null; $mutex.Dispose(); exit }
$client = New-Object Net.Http.HttpClient
$client.Timeout = [TimeSpan]::FromSeconds(45)
$client.DefaultRequestHeaders.Authorization = New-Object Net.Http.Headers.AuthenticationHeaderValue('Bearer', $config.key)
$base = "http://127.0.0.1:$($config.port)"
$form = New-Object Windows.Forms.Form
$form.Text = '好好唱资源 AI 整理器'
$form.Size = New-Object Drawing.Size(640, 495)
$form.MinimumSize = $form.Size
$form.StartPosition = 'CenterScreen'
$form.BackColor = [Drawing.Color]::FromArgb(246,245,249)
$form.Font = New-Object Drawing.Font('Microsoft YaHei UI', 10)
$icon = Join-Path $PSScriptRoot 'ui/icon.ico'
$form.Icon = New-Object Drawing.Icon($icon)
$heading = New-Object Windows.Forms.Label
$heading.Text = '正在连接本机整理器…'
$heading.Font = New-Object Drawing.Font('Microsoft YaHei UI', 15, [Drawing.FontStyle]::Bold)
$heading.SetBounds(24,24,570,42)
$metrics = New-Object Windows.Forms.Label
$metrics.SetBounds(24,75,570,85)
$tasks = New-Object Windows.Forms.TextBox
$tasks.SetBounds(24,166,570,130)
$tasks.Multiline = $true; $tasks.ReadOnly = $true; $tasks.ScrollBars = 'Vertical'
$tasks.BorderStyle = 'None'; $tasks.BackColor = $form.BackColor
$updateLabel = New-Object Windows.Forms.Label
$updateLabel.SetBounds(24,305,570,48)
$downloadLink = New-Object Windows.Forms.LinkLabel
$downloadLink.Text = '手动下载更新包'
$downloadLink.SetBounds(24,410,570,24)
$downloadLink.Add_LinkClicked({ Start-Process 'https://github.com/xudong7587/haohaochang-KTV/releases/latest' })
$buttons = @()
foreach ($spec in @(@('查看详细任务',24,145), @('检查更新',182,128), @('退出整理器',324,128), @('隐藏窗口',465,128))) {
  $button = New-Object Windows.Forms.Button
  $button.Text = $spec[0]; $button.SetBounds($spec[1],365,$spec[2],38)
  $buttons += $button
  $form.Controls.Add($button)
}
$buttons[1].Visible = $false
$form.Controls.AddRange(@($heading,$metrics,$tasks,$updateLabel,$downloadLink))
$tray = New-Object Windows.Forms.NotifyIcon
$tray.Icon = $form.Icon; $tray.Text = '好好唱资源 AI 整理器'; $tray.Visible = $true
$menu = New-Object Windows.Forms.ContextMenuStrip
$showItem = $menu.Items.Add('显示整理器')
$updateItem = $menu.Items.Add('检查更新')
$updateItem.Visible = $false
$exitItem = $menu.Items.Add('退出整理器')
$tray.ContextMenuStrip = $menu
$script:firstTick = $true; $script:queuedAction = $null; $script:leaving = $false; $script:request = $null; $script:action = ''; $script:latest = ''; $script:phase = ''; $script:failures = 0; $script:retryAt = 0
function Show-Organizer { $form.Show(); $form.WindowState = 'Normal'; $form.Activate() }
function Refresh-WorkerCredential {
  try {
    $next = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'worker.json') -Raw | ConvertFrom-Json
    if ($next.key -and $next.key -ne $script:config.key) {
      $script:config = $next
      $client.DefaultRequestHeaders.Authorization = New-Object Net.Http.Headers.AuthenticationHeaderValue('Bearer', $next.key)
    }
  } catch { }
}
function Request-Action($action, $body = '{}') {
  if ($script:request) { $script:queuedAction = @($action,$body); $updateLabel.Text = '等待当前状态请求完成…'; return }
  $script:action = $action
  $content = New-Object Net.Http.StringContent($body, [Text.Encoding]::UTF8, 'application/json')
  $script:request = $client.PostAsync("$base/desktop/$action", $content)
  $updateLabel.Text = '正在处理…'
}
function Update-Organizer {
  Show-Organizer
  if ($script:phase -eq 'failed' -and $script:retryAt -gt [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()) { return }
  if ($script:phase -eq 'available') {
    Request-Action 'update/install' ('{"version":"' + $script:latest + '"}')
  } elseif ($script:phase -in @('downloading','waiting')) {
    Request-Action 'update/cancel'
  } else { Request-Action 'update/check' }
}
$buttons[0].Add_Click({ Start-Process "$base/ui#$($config.key)" })
$buttons[1].Add_Click({ Update-Organizer })
$buttons[2].Add_Click({ Request-Action 'shutdown' })
$buttons[3].Add_Click({ $form.Hide() })
$showItem.Add_Click({ Show-Organizer }); $tray.Add_DoubleClick({ Show-Organizer })
$updateItem.Add_Click({ Update-Organizer }); $exitItem.Add_Click({ Request-Action 'shutdown' })
$form.Add_FormClosing({ param($sender,$eventArgs) if (!$script:leaving) { $eventArgs.Cancel = $true; $form.Hide(); $tray.ShowBalloonTip(2500,'好好唱仍在运行','右下角图标可以查看任务或退出。',[Windows.Forms.ToolTipIcon]::Info) } })
$labels = @{idle='可以检查新版';checking='正在检查新版';available='发现新版';current='已是最新版本';downloading='正在下载';waiting='等待当前任务完成';installing='正在安装';restarting='正在重新启动';complete='更新完成';failed='更新失败';cancelled='已取消更新'}
$timer = New-Object Windows.Forms.Timer
$timer.Interval = 500
$script:nextPoll = [DateTime]::MinValue
$timer.Add_Tick({
  if ($script:firstTick) { $script:firstTick = $false; if ($env:RESOURCE_AI_SHOW_WINDOW -ne '0') { Show-Organizer } }
  if (Test-Path -LiteralPath $marker) { Remove-Item -LiteralPath $marker; Show-Organizer }
  if ($script:request -and $script:request.IsCompleted) {
    try {
      $response = $script:request.GetAwaiter().GetResult()
      $value = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
      if (!$response.IsSuccessStatusCode) { throw $value.detail }
      $script:failures = 0
      if ($script:action -eq 'shutdown') { $script:leaving = $true; $form.Close(); return }
      if ($script:action -eq 'status') {
        $heading.Text = "好好唱整理器  v$($value.version)"
        $gpuText = if ($value.gpu) { "GPU $($value.gpu.busiest)%  ·  显存 $($value.gpu.used_mb) / $($value.gpu.total_mb) MB" } else { 'CPU 模式 · GPU 未启用' }
        $metrics.Text = "$($value.gpu_name)`r`n$gpuText`r`nCPU $($value.cpu)%  ·  内存 $($value.memory.used_gb) / $($value.memory.total_gb) GB"
        $active = @($value.jobs | Where-Object { $_.status -in @('uploading','queued','running') })
        $tasks.Text = if ($active.Count) { ($active | ForEach-Object { "$($_.title)  ·  $($_.stage)  $($_.model_progress)%" }) -join "`r`n" } else { '当前没有任务，等待 NAS 派发。' }
        $value = $value.update
      }
      $script:phase = $value.phase; $script:latest = $value.latest
      $script:retryAt = [double]$value.nextCheck
      $updateLabel.Text = '应用内更新已暂停，请手动下载覆盖安装。'

      $buttons[1].Text = if ($value.phase -eq 'available') { '安装新版' } elseif ($value.phase -in @('downloading','waiting')) { '取消更新' } else { '检查更新' }
      $buttons[1].Enabled = ($value.phase -notin @('checking','installing','restarting')) -and !($value.phase -eq 'failed' -and $script:retryAt -gt [DateTimeOffset]::UtcNow.ToUnixTimeSeconds())
      $updateItem.Enabled = $buttons[1].Enabled
    } catch {
      $script:failures++
      $updateLabel.Text = if ($script:action -eq 'status') { '服务暂不可用；更新期间会自动重连。' } else { [string]$_ }
      if ($script:action -ne 'status') { Show-Organizer }
      if ($script:failures -gt 80) { $script:leaving = $true; $form.Close() }
    } finally { $script:request = $null; $script:nextPoll = [DateTime]::Now.AddSeconds(3) }
  }
  if (!$script:request) { Refresh-WorkerCredential }
  if (!$script:request -and $script:queuedAction) { $queued = $script:queuedAction; $script:queuedAction = $null; Request-Action $queued[0] $queued[1] }
  if (!$script:request -and [DateTime]::Now -gt $script:nextPoll) { $script:action = 'status'; $script:request = $client.GetAsync("$base/desktop/status") }
})
$form.Add_Shown({ if ($env:RESOURCE_AI_SHOW_WINDOW -eq '0') { $form.Hide() } })
try { $timer.Start(); [Windows.Forms.Application]::Run($form) }
finally { $timer.Stop(); $tray.Visible = $false; $tray.Dispose(); $client.Dispose(); $mutex.ReleaseMutex(); $mutex.Dispose() }

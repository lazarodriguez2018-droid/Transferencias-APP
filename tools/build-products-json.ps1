param(
  [Parameter(Mandatory = $true)]
  [string]$InputPath,
  [string]$OutputPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'products.json')
)

$resolvedInput = (Resolve-Path -LiteralPath $InputPath).Path
$resolvedOutput = [IO.Path]::GetFullPath($OutputPath)
$temporaryCsv = Join-Path ([IO.Path]::GetTempPath()) ("sucaneitor-padron-{0}.csv" -f [Guid]::NewGuid())
$excel = $null
$workbook = $null
$worksheet = $null

try {
  $excel = New-Object -ComObject Excel.Application
  $excel.Visible = $false
  $excel.DisplayAlerts = $false
  $workbook = $excel.Workbooks.Open($resolvedInput, 0, $true)
  $worksheet = $workbook.Worksheets.Item(1)
  $worksheet.SaveAs($temporaryCsv, 62)
  $workbook.Close($false)
  [Runtime.InteropServices.Marshal]::ReleaseComObject($workbook) | Out-Null
  $workbook = $null

  $lines = @(Get-Content -LiteralPath $temporaryCsv -Encoding utf8)
  $headerIndex = -1
  for ($index = 0; $index -lt [Math]::Min($lines.Count, 30); $index++) {
    if ($lines[$index] -match 'C[oó]digo' -and $lines[$index] -match 'Barras' -and $lines[$index] -match 'Nombre') {
      $headerIndex = $index
      break
    }
  }
  if ($headerIndex -lt 0) { throw 'No se encontró la fila de encabezados en el archivo convertido.' }
  $delimiter = if (($lines[$headerIndex].ToCharArray() | Where-Object { $_ -eq ';' }).Count -gt ($lines[$headerIndex].ToCharArray() | Where-Object { $_ -eq ',' }).Count) { ';' } else { ',' }
  if ($env:SUCANEITOR_PADRON_DEBUG -eq '1') {
    Write-Output "HEADER=$($lines[$headerIndex])"
    Write-Output "FIRST=$($lines[$headerIndex + 1])"
    Write-Output "DELIMITER=$delimiter"
  }
  $headers = @('codigo','barras','nombre','padre','unidad','envase','impuesto','fabricante','marca','tipo','familias')
  $rows = $lines |
    Select-Object -Skip ($headerIndex + 1) |
    ConvertFrom-Csv -Delimiter $delimiter -Header $headers

  $products = @($rows | ForEach-Object {
    $codigo = ([string]$_.codigo).Trim()
    $nombre = ([string]$_.nombre).Trim()
    if ($codigo -and $nombre) {
      [ordered]@{
        codigo = $codigo
        barras = ([string]$_.barras).Trim()
        nombre = $nombre
        fabricante = ([string]$_.fabricante).Trim()
        marca = ([string]$_.marca).Trim()
      }
    }
  })

  $barcodeCount = @($products | Where-Object { $_.barras }).Count
  if ($products.Count -lt 1000 -or $barcodeCount -eq 0) {
    throw "El padrón convertido no superó la validación ($($products.Count) productos, $barcodeCount códigos de barras)."
  }

  $json = ConvertTo-Json -InputObject $products -Depth 4 -Compress
  [IO.File]::WriteAllText($resolvedOutput, $json, [Text.UTF8Encoding]::new($false))
  Write-Output "PRODUCTS=$($products.Count) WITH_BARCODE=$barcodeCount OUTPUT=$resolvedOutput"
}
finally {
  if ($worksheet) { [Runtime.InteropServices.Marshal]::ReleaseComObject($worksheet) | Out-Null }
  if ($workbook) {
    $workbook.Close($false)
    [Runtime.InteropServices.Marshal]::ReleaseComObject($workbook) | Out-Null
  }
  if ($excel) {
    $excel.Quit()
    [Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null
  }
  if (Test-Path -LiteralPath $temporaryCsv) { Remove-Item -LiteralPath $temporaryCsv -Force }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}

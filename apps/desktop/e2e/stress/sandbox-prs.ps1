# Makes sure the throwaway sandbox repo has two open dummy pull requests for the merge test.
#   powershell -File sandbox-prs.ps1 -Repo owner/clicky-sandbox -User owner
param([string]$Repo, [string]$User)
$ErrorActionPreference = 'Continue'
$env:GH_TOKEN = (gh auth token --user $User)
$open = [int](gh pr list -R $Repo --state open --json number --jq length)
if ($open -ge 2) { "already $open open"; exit 0 }
$dir = Join-Path $env:TEMP "clicky-sandbox-$(Get-Random)"
git clone -q "https://x-access-token:$($env:GH_TOKEN)@github.com/$Repo.git" $dir
Push-Location $dir
git config user.name $User
git config user.email "$User@users.noreply.github.com"
$stamp = Get-Date -Format 'yyyyMMddHHmmss'
for ($n = $open + 1; $n -le 2; $n++) {
  git checkout -q main
  git checkout -q -b "test/dummy-$stamp-$n"
  "Dummy change $n ($stamp) for Clicky's agent test." | Set-Content "dummy-$stamp-$n.txt"
  git add .
  git commit -qm "Dummy change $n"
  git push -q origin "test/dummy-$stamp-$n" 2>&1 | Out-Null
  gh pr create -R $Repo --head "test/dummy-$stamp-$n" --base main --title "Dummy PR $n (Clicky test $stamp)" --body "Throwaway PR for Clicky's agent merge test."
}
Pop-Location
Remove-Item -Recurse -Force $dir

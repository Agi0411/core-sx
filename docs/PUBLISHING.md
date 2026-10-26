# 發佈到 GitHub（開源）教學

這份教學從「發佈前檢查」一路走到「第一個 Release」。專案裡已經備好 `.gitignore`、`LICENSE`、README、CI 與發佈流程，你只需要照順序做。

## 0. 發佈前檢查（最重要）

公開之後，所有人都能看到完整的 commit 歷史，**一旦推上去就很難徹底收回**，所以先確認這幾項：

| 項目 | 要確認什麼 |
|---|---|
| `public/sounds/`（約 13 MB、1800 多個音效檔） | 這些音效是你自己製作、合成，或授權允許再散佈嗎？不確定就不要公開：從專案移除，並在 `.gitignore` 加上這個資料夾，README 改成下載連結。 |
| `tests/fixture-spd/`（約 2 MB） | 是否來自真實的 SPD-SX 備份？裡面可能有你的 Kit 名稱、個人資料或 Roland 的受版權保護內容。建議換成自製的合成資料。 |
| 秘密與憑證 | `.env.release`、`*.p12`、API Key、Apple 帳號資訊都不能進 repo（`.gitignore` 已擋，仍請用 `git status` 親眼確認）。 |
| 個人資訊 | App 的 Credit 區有你的 Instagram 與 Gmail，開源後會一併公開。如果不想公開，請在 `src/renderer/main.tsx` 搜尋 `agilin0411` 後移除。 |
| 商標 | README 已加上「與 Roland 無關」的聲明。不要使用 Roland 的官方 Logo 或產品圖。 |
| 授權 | 預設是 **MIT**（最寬鬆，別人可商用、改作，只需保留版權聲明）。想要「別人改作後也必須開源」可改 GPL-3.0；想要明確的專利授權可改 Apache-2.0。Logo 也會被 MIT 涵蓋，若想保留 Logo 的權利，請在 `LICENSE` 末尾加註一行。 |
| 帳號名稱 | 把 `package.json` 與 `README*.md` 裡的 `<your-account>` 全部換成你的 GitHub 帳號。 |

## 1. 安裝工具

```bash
brew install git gh
gh auth login          # 依指示用瀏覽器登入 GitHub
```

## 2. 在本機建立 Git 倉庫並檢查內容

```bash
cd core-sx             # 專案資料夾
git init -b main
git add -A
git status             # 逐項看一遍，確認沒有 node_modules、release、.env、*.p12
git ls-files | wc -l   # 檔案數量
git ls-files -z | xargs -0 du -ch | tail -1     # 總大小
```

單一檔案超過 100 MB 會被 GitHub 拒絕；超過 50 MB 會警告（可改用 Git LFS）。

## 3. 第一次提交並推上 GitHub

方式 A：用 `gh` 一行完成（建議）

```bash
git commit -m "Initial public release v1.1.0"
gh repo create <你的帳號>/core-sx --public --source=. --remote=origin --push \
  --description "Editor, MIDI controller and computer instrument for the Roland SPD-SX"
```

方式 B：網頁操作

1. 到 <https://github.com/new>，名稱填 `core-sx`，選 Public。**不要**勾選 README、.gitignore、license（專案已經有了）。
2. 照頁面顯示的指令：

```bash
git commit -m "Initial public release v1.1.0"
git remote add origin git@github.com:<你的帳號>/core-sx.git
git push -u origin main
```

## 4. 倉庫設定（網頁上）

- **About**（首頁右上角齒輪）：填一句描述與 Topics，例如 `roland` `spd-sx` `electron` `midi` `sampler`。
- **Settings → General → Features**：開啟 Issues；想讓使用者討論就開 Discussions。
- **Settings → Code security**：開啟 Dependabot alerts 與 Private vulnerability reporting。
- （選用）**Settings → Branches**：對 `main` 設定「合併前需要通過 CI」。

推上去之後，`.github/workflows/ci.yml` 會自動在每次 push 與 Pull Request 時建置並跑測試。

## 5. 發佈第一個版本（Release）

版本號以 `package.json` 的 `version` 為準（App 標題列也讀它）。發版流程：

```bash
# 1. 改 package.json 的 version（例如 1.1.1），提交
git commit -am "Release v1.1.1"
git push

# 2. 打 tag 並推上去，GitHub Actions 就會自動建置安裝檔
git tag v1.1.1
git push origin v1.1.1
```

`.github/workflows/release.yml` 會在 macOS 上建置，並把 `.dmg` 與 `.zip` 附到 Releases 頁面（建置通常需要十幾分鐘，實際時間依 GitHub 當時的負載而定）。

不想用 Actions 的話，也可以在自己的 Mac 上建置後手動上傳：

```bash
npm run dist:mac:arm64:unsigned
gh release create v1.1.1 release/*.dmg release/*.zip --generate-notes
```

## 6. 簽署與公證（要不要做？）

- **不做**：免費。使用者第一次開啟時，macOS 會警告「無法驗證開發者」，需要在 Finder 對 App 按右鍵 → 打開，或在終端機執行 `xattr -dr com.apple.quarantine "/Applications/Core SX.app"`。請把這段寫在 Release 說明裡。
- **要做**：需要 Apple Developer Program（每年 US$99）、Developer ID Application 憑證，並完成公證。流程見專案的 [RELEASE.md](../RELEASE.md)。到 GitHub 的 **Settings → Secrets and variables → Actions** 新增 `CSC_LINK`（憑證 .p12 的 base64）、`CSC_KEY_PASSWORD`、`APPLE_API_KEY`、`APPLE_API_KEY_ID`、`APPLE_API_ISSUER`，再把 `release.yml` 裡的指令改成 `npm run dist:mac:arm64`。

## 7. 常見問題

- **不小心把密碼、憑證推上去了**：立刻到對應服務撤銷並更換（光刪檔案沒用，歷史裡還在），再用 [git filter-repo](https://github.com/newren/git-filter-repo) 清除歷史並強制推送。
- **`npm install` 在 `electron-rebuild` 失敗**：先執行 `xcode-select --install`。
- **CI 或 Release 失敗**：到 Actions 頁面點進失敗的 job 看日誌。這兩個流程是依專案的 `package.json` 腳本撰寫的範本，我沒辦法在 GitHub 上實際執行，第一次跑如果需要微調很正常。
- **Windows / Linux**：目前專案只針對 macOS 打包與測試。

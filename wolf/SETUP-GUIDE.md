# セットアップガイド

## 現在の状態

✅ Firebase SDKの実装完了（ES Modules形式）
✅ ルーム作成・参加機能の実装完了
✅ リアルタイム同期機能の実装完了

## 次に行うべきこと

### 1. Firebase Consoleでの設定（必須）

#### 1.1 Firestore Databaseの作成
1. [Firebase Console](https://console.firebase.google.com/)にアクセス
2. プロジェクト「an-wolf」を選択
3. 左メニューから「Firestore Database」を選択
4. 「データベースを作成」をクリック
5. **本番モード**または**テストモード**を選択（後でセキュリティルールを設定します）
6. ロケーションを選択（例: `asia-northeast1`）

#### 1.2 Firestoreセキュリティルールの設定
1. Firestore Database画面で「ルール」タブを開く
2. 以下のルールを設定：

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{roomId} {
      // ルームデータの読み取り（認証済みユーザーは全員読み取り可能）
      allow read: if request.auth != null;
      
      // ルームデータの書き込み
      allow create: if request.auth != null;
      
      // ルームデータの更新
      allow update: if request.auth != null && (
        // GMは全権限
        resource.data.config.createdBy == request.auth.uid ||
        // 自分のプレイヤーデータのみ更新可能
        request.resource.data.diff(resource.data).affectedKeys()
          .hasOnly(['players.' + request.auth.uid])
      );
      
      // ルームデータの削除（GMのみ）
      allow delete: if request.auth != null && 
        resource.data.config.createdBy == request.auth.uid;
    }
  }
}
```

3. 「公開」をクリック

#### 1.3 Authenticationの有効化
1. 左メニューから「Authentication」を選択
2. 「始める」をクリック（初回のみ）
3. 「Sign-in method」タブを開く
4. 「匿名」を選択
5. 「有効にする」をクリック
6. 「保存」をクリック

### 2. 動作確認

#### 2.1 ローカルでのテスト（推奨：最初の検証）
1. ローカルサーバーを起動（ES Modulesは`file://`プロトコルでは動作しないため）
   ```bash
   # Python 3の場合
   python -m http.server 8000
   
   # Node.jsの場合（http-serverをインストール）
   npx http-server -p 8000
   ```
2. ブラウザで `http://localhost:8000` にアクセス
3. 開発者ツール（F12）のコンソールを開く
4. 「ルーム作成（GM）」をクリック
5. プレイヤーを設定して「ゲーム開始」をクリック
6. ルームIDが表示されることを確認

**ローカル検証のメリット:**
- すぐに始められる（GitHubへのプッシュ不要）
- エラー修正が速い
- デバッグが簡単

#### 2.2 GitHub Pagesでのテスト（推奨：共有・最終確認）
1. GitHubリポジトリを作成してプッシュ
2. GitHub Pagesを有効化（Settings → Pages）
3. デプロイ完了後（数分）、公開URLにアクセス
4. 複数人で同時にテスト

**GitHub Pages検証のメリット:**
- 複数人で同時にテストできる
- 本番環境と同じ条件（HTTPS）
- 実際の使用環境に近い

詳細は `TESTING-GUIDE.md` を参照してください。

#### 2.3 エラーの確認
- コンソールにエラーが表示されていないか確認
- ネットワークタブでFirebaseへのリクエストが成功しているか確認

### 3. よくある問題と解決方法

#### 問題1: ルームIDが表示されない
**原因:**
- Firebase認証が失敗している
- Firestoreのセキュリティルールが正しく設定されていない
- ネットワークエラー

**解決方法:**
1. ブラウザのコンソールでエラーメッセージを確認
2. Firebase ConsoleでAuthenticationが有効になっているか確認
3. Firestoreのセキュリティルールを確認
4. ネットワーク接続を確認

#### 問題2: "Permission denied" エラー
**原因:**
- Firestoreのセキュリティルールが厳しすぎる

**解決方法:**
1. 一時的にテストモードに変更（開発中のみ）
2. または、上記のセキュリティルールを再確認

#### 問題3: "Firebase SDK is not loaded" エラー
**原因:**
- ES Modulesが正しく読み込まれていない
- ローカルファイルを直接開いている（`file://`プロトコル）

**解決方法:**
1. ローカルサーバーを使用してアクセス
2. `index.html`の`<script type="module">`が正しく設定されているか確認

### 4. デプロイ（GitHub Pages）

#### 4.1 GitHubリポジトリの準備
1. GitHubにリポジトリを作成
2. ファイルをコミット・プッシュ

#### 4.2 GitHub Pagesの設定
1. リポジトリの「Settings」→「Pages」を開く
2. 「Source」で「main」ブランチを選択
3. 「Save」をクリック
4. 数分後に `https://[username].github.io/[repository-name]` でアクセス可能

### 5. 次のステップ（オプション）

- [ ] エラーハンドリングの改善
- [ ] ローディング表示の追加
- [ ] ルーム一覧機能の追加
- [ ] プレイヤー退出時の処理
- [ ] ゲーム履歴の保存
- [ ] UI/UXの改善

## トラブルシューティング

### デバッグ方法
1. ブラウザの開発者ツール（F12）を開く
2. コンソールタブでエラーメッセージを確認
3. ネットワークタブでFirebaseへのリクエストを確認
4. ApplicationタブでLocal Storageを確認（認証情報など）

### ログの確認
- `main.js`に`console.log`を追加してデバッグ
- Firebase Consoleの「Authentication」→「Users」で認証状態を確認
- Firestore Consoleでデータが正しく保存されているか確認

## サポート

問題が解決しない場合は、以下を確認してください：
1. Firebase Consoleの設定が正しいか
2. ブラウザのコンソールエラー
3. ネットワーク接続
4. Firebase SDKのバージョン

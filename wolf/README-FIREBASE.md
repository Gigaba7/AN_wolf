# Firebase同期機能のセットアップ

## 概要

このアプリケーションはFirebaseを使用してリアルタイム同期機能を提供します。

## セットアップ手順

### 1. Firebaseプロジェクトの作成

1. [Firebase Console](https://console.firebase.google.com/)にアクセス
2. 新しいプロジェクトを作成
3. プロジェクト設定からWebアプリを追加
4. 設定情報（apiKey, authDomain, projectId等）を取得

### 2. Firebase設定の適用

`firebase-config.js`ファイルを開き、以下の設定値を実際のFirebaseプロジェクトの値に置き換えてください：

```javascript
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};
```

### 3. Firestoreセキュリティルールの設定

Firebase ConsoleのFirestore Databaseセクションで、以下のセキュリティルールを設定してください：

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /rooms/{roomId} {
      // ルームデータの読み取り（参加者は全員読み取り可能）
      allow read: if request.auth != null;
      
      // ルームデータの書き込み
      allow write: if request.auth != null && (
        // GMは全権限
        resource.data.config.createdBy == request.auth.uid ||
        // 自分のプレイヤーデータのみ更新可能
        request.resource.data.diff(resource.data).affectedKeys()
          .hasOnly(['players.' + request.auth.uid])
      );
      
      // ゲーム状態の更新（GMのみ）
      match /gameState/{document=**} {
        allow read: if request.auth != null;
        allow write: if request.auth != null && 
          get(/databases/$(database)/documents/rooms/$(roomId)).data.config.createdBy == request.auth.uid;
      }
    }
  }
}
```

### 4. Authenticationの有効化

1. Firebase ConsoleのAuthenticationセクションに移動
2. 「Sign-in method」タブを開く
3. 「匿名」認証を有効化

### 5. 使用方法

#### GM（ホスト）としてゲームを開始

1. ホーム画面で「ルーム作成（GM）」をクリック
2. プレイヤーを設定（3〜8人）
3. 「ゲーム開始」をクリック
4. 表示されたルームIDを参加者に共有

#### プレイヤーとして参加

1. ホーム画面で「ルーム参加」をクリック
2. GMから受け取ったルームIDを入力
3. 自分の名前を入力
4. 「参加」をクリック

## 機能

- **リアルタイム同期**: ゲーム状態が全参加者間でリアルタイムに同期されます
- **役職管理**: 各プレイヤーの役職情報が自動的に管理されます
- **ログ共有**: ゲームログが全員で共有されます
- **乱数管理**: ステージ抽選や妨害抽選の結果が保存・共有されます

## 注意事項

- Firebaseが利用できない環境では、オフラインモードで動作します
- ルームはGMが退出すると自動的に削除されます
- 匿名認証を使用しているため、ブラウザのデータを削除すると再認証が必要です

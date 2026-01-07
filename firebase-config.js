// Firebase設定
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js";

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyDqXufF3j3Eq7AN_eyKB6bb07gUNLc3dpc",
  authDomain: "an-wolf.firebaseapp.com",
  projectId: "an-wolf",
  storageBucket: "an-wolf.firebasestorage.app",
  messagingSenderId: "747848012766",
  appId: "1:747848012766:web:3fa3c6e8b71cba8330434f"
};

// Initialize Firebase
const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const firestore = getFirestore(firebaseApp);

// エクスポート
export { firebaseApp, auth, firestore };

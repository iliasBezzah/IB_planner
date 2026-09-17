// ╔══════════════════════════════════════════════════════╗
// ║  IB Student Planner — Firebase Cloud Sync Config    ║
// ╚══════════════════════════════════════════════════════╝

const firebaseConfig = {
  apiKey: "AIzaSyC7EBRjCB1ZIqYaG4TlTc-r0Y6EaaC4UCQ",
  authDomain: "ib-student-planner-b85cd.firebaseapp.com",
  projectId: "ib-student-planner-b85cd",
  storageBucket: "ib-student-planner-b85cd.firebasestorage.app",
  messagingSenderId: "1050699803197",
  appId: "1:1050699803197:web:7c20ca728a0514d9011854",
  measurementId: "G-PNBE92L614"
};

// Initialize Firebase
if (typeof firebase !== 'undefined') {
  if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
  }
}

import { getApps, initializeApp } from 'firebase/app'
import { getAnalytics, isSupported } from 'firebase/analytics'
import { getAuth, GoogleAuthProvider } from 'firebase/auth'

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
}

const requiredFirebaseConfig = [
  firebaseConfig.apiKey,
  firebaseConfig.authDomain,
  firebaseConfig.projectId,
  firebaseConfig.storageBucket,
  firebaseConfig.messagingSenderId,
  firebaseConfig.appId,
]

export const firebaseConfigured = requiredFirebaseConfig.every(Boolean)
export const firebaseApp = firebaseConfigured ? (getApps().length ? getApps()[0] : initializeApp(firebaseConfig)) : null
export const auth = firebaseApp ? getAuth(firebaseApp) : null
export const analytics = firebaseApp && typeof window !== 'undefined' && firebaseConfig.measurementId
  ? isSupported().then((supported) => supported ? getAnalytics(firebaseApp) : null)
  : Promise.resolve(null)
export const googleProvider = new GoogleAuthProvider()

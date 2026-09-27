/* NovaSol — Firebase bridge Build 501
   Inicializa Firebase somente quando NOVASOL_FIREBASE_CONFIG estiver preenchido.
   Nesta build não há leitura nem gravação automática no Firestore.
*/
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  setPersistence,
  browserLocalPersistence
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

const required=['apiKey','authDomain','projectId','appId'];
const cfg=window.NOVASOL_FIREBASE_CONFIG;
const configured=!!cfg && required.every(k=>typeof cfg[k]==='string' && cfg[k].trim());

function emit(status,detail={}){
  window.dispatchEvent(new CustomEvent('novasol:cloud-status',{detail:{status,...detail}}));
}

if(!configured){
  window.NovaSolCloud={
    ready:false,
    configured:false,
    status:'unconfigured',
    app:null,
    auth:null,
    db:null,
    currentUser:()=>null,
    signIn:async()=>{throw new Error('NovaSol Firebase ainda não configurado.');},
    signOut:async()=>{},
    configProjectId:null
  };
  emit('unconfigured');
}else{
  try{
    const app=initializeApp(cfg);
    const auth=getAuth(app);
    const db=getFirestore(app);
    const provider=new GoogleAuthProvider();
    provider.setCustomParameters({prompt:'select_account'});
    try{await setPersistence(auth,browserLocalPersistence)}catch(e){console.warn('NovaSol Firebase: persistência de autenticação indisponível',e)}

    const api={
      ready:true,
      configured:true,
      status:'ready',
      app,auth,db,
      provider,
      currentUser:()=>auth.currentUser,
      signIn:()=>signInWithPopup(auth,provider),
      signOut:()=>signOut(auth),
      configProjectId:cfg.projectId
    };
    window.NovaSolCloud=api;
    emit('ready',{projectId:cfg.projectId});

    onAuthStateChanged(auth,user=>{
      window.dispatchEvent(new CustomEvent('novasol:auth-changed',{detail:{
        signedIn:!!user,
        uid:user?.uid||null,
        email:user?.email||null,
        displayName:user?.displayName||null,
        photoURL:user?.photoURL||null
      }}));
    });
  }catch(error){
    console.error('NovaSol Firebase: falha ao inicializar',error);
    window.NovaSolCloud={
      ready:false,
      configured:true,
      status:'error',
      error,
      app:null,auth:null,db:null,
      currentUser:()=>null,
      signIn:async()=>{throw error;},
      signOut:async()=>{},
      configProjectId:cfg?.projectId||null
    };
    emit('error',{message:error?.message||String(error)});
  }
}

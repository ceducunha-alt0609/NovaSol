/* NovaSol — Firebase bridge Build 508
   Inicializa Firebase somente quando NOVASOL_FIREBASE_CONFIG estiver preenchido.
   Nesta build há diagnóstico e cópia manual do estado local para a nuvem.
   Não há sincronização automática nem restauração automática.
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
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  writeBatch,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js';

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
      async testConnection(){
        const user=auth.currentUser;
        if(!user)throw new Error('Faça login com Google antes de testar a conexão.');
        const ref=doc(db,'users',user.uid,'diagnostics','connectivity');
        const payload={
          kind:'connectivity-test',
          app:'NovaSol',
          build:508,
          source:'web',
          updatedAt:serverTimestamp()
        };
        await setDoc(ref,payload,{merge:true});
        const snap=await getDoc(ref);
        if(!snap.exists())throw new Error('O diagnóstico foi enviado, mas não pôde ser lido de volta.');
        return {ok:true,path:ref.path,data:snap.data()};
      },
      async createCloudBackup(rawState,meta={}){
        const user=auth.currentUser;
        if(!user)throw new Error('Faça login com Google antes de enviar a cópia.');
        if(typeof rawState!=='string'||!rawState.trim())throw new Error('Estado local vazio; nada foi enviado.');

        const DEVICE_KEY='novasol_device_id_v1';
        let deviceId=localStorage.getItem(DEVICE_KEY);
        if(!deviceId){
          deviceId=(globalThis.crypto?.randomUUID?.()||('ns-device-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2)));
          localStorage.setItem(DEVICE_KEY,deviceId);
        }

        const bytes=new TextEncoder().encode(rawState);
        const digest=await crypto.subtle.digest('SHA-256',bytes);
        const sha256=[...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');

        // 200k chars keeps every Firestore chunk safely below the 1 MiB document limit,
        // even with multibyte UTF-8 text.
        const CHUNK_CHARS=200000;
        const chunks=[];
        for(let i=0;i<rawState.length;i+=CHUNK_CHARS)chunks.push(rawState.slice(i,i+CHUNK_CHARS));

        const snapshotId=(new Date().toISOString().replace(/[-:.TZ]/g,'').slice(0,14))+'-'+(crypto.randomUUID?.()||Math.random().toString(36).slice(2,10));
        const backupRef=doc(db,'users',user.uid,'cloudBackups',snapshotId);
        const batch=writeBatch(db);

        chunks.forEach((data,index)=>{
          batch.set(doc(db,'users',user.uid,'cloudBackups',snapshotId,'chunks',String(index).padStart(4,'0')),{
            index,
            data
          });
        });

        batch.set(backupRef,{
          kind:'novasol-cloud-backup',
          app:'NovaSol',
          build:508,
          schema:Number(meta.schema)||null,
          localSavedAt:meta.localSavedAt||null,
          sourceDeviceId:deviceId,
          sourcePlatform:'desktop',
          chunkCount:chunks.length,
          charLength:rawState.length,
          byteLength:bytes.length,
          sha256,
          clientCreatedAt:new Date().toISOString(),
          serverCreatedAt:serverTimestamp()
        });

        batch.set(doc(db,'users',user.uid,'cloudState','current'),{
          latestSnapshotId:snapshotId,
          build:508,
          schema:Number(meta.schema)||null,
          sourceDeviceId:deviceId,
          chunkCount:chunks.length,
          byteLength:bytes.length,
          sha256,
          updatedAt:serverTimestamp()
        });

        await batch.commit();

        // Read the exact payload back and verify SHA-256.
        const savedMeta=await getDoc(backupRef);
        if(!savedMeta.exists())throw new Error('A cópia foi enviada, mas o manifesto não pôde ser lido de volta.');

        const returned=[];
        for(let i=0;i<chunks.length;i++){
          const snap=await getDoc(doc(db,'users',user.uid,'cloudBackups',snapshotId,'chunks',String(i).padStart(4,'0')));
          if(!snap.exists())throw new Error('A cópia ficou incompleta na nuvem (bloco '+(i+1)+').');
          returned.push(String(snap.data()?.data||''));
        }
        const restored=returned.join('');
        const restoredDigest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(restored));
        const restoredSha=[...new Uint8Array(restoredDigest)].map(b=>b.toString(16).padStart(2,'0')).join('');
        if(restoredSha!==sha256)throw new Error('A verificação de integridade falhou: a cópia retornou diferente do estado local.');

        return {
          ok:true,
          snapshotId,
          chunkCount:chunks.length,
          byteLength:bytes.length,
          sha256,
          verified:true,
          deviceId
        };
      },
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

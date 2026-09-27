/* NovaSol — Firebase bridge Build 512
   Inicializa Firebase somente quando NOVASOL_FIREBASE_CONFIG estiver preenchido.
   Nesta build a restauração controlada entrega a cópia validada à rotina nativa de restauração do NovaSol.
   Não há sincronização automática. A restauração exige prévia e confirmação explícita.
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
      async readLatestCloudBackup(){
        const user=auth.currentUser;
        if(!user)throw new Error('Faça login com Google antes de conferir a nuvem.');

        const stateRef=doc(db,'users',user.uid,'cloudState','current');
        const stateSnap=await getDoc(stateRef);
        if(!stateSnap.exists())throw new Error('Ainda não existe uma cópia registrada na nuvem.');

        const state=stateSnap.data()||{};
        const snapshotId=String(state.latestSnapshotId||'');
        if(!snapshotId)throw new Error('A referência da última cópia está vazia.');

        const backupRef=doc(db,'users',user.uid,'cloudBackups',snapshotId);
        const metaSnap=await getDoc(backupRef);
        if(!metaSnap.exists())throw new Error('O manifesto da última cópia não foi encontrado.');

        const meta=metaSnap.data()||{};
        const count=Number(meta.chunkCount||state.chunkCount||0);
        if(!Number.isInteger(count)||count<1)throw new Error('A cópia não informa uma quantidade válida de blocos.');

        const returned=[];
        for(let i=0;i<count;i++){
          const snap=await getDoc(doc(db,'users',user.uid,'cloudBackups',snapshotId,'chunks',String(i).padStart(4,'0')));
          if(!snap.exists())throw new Error('A cópia está incompleta na nuvem (bloco '+(i+1)+').');
          returned.push(String(snap.data()?.data||''));
        }

        const rawState=returned.join('');
        const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(rawState));
        const sha256=[...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
        const expected=String(meta.sha256||state.sha256||'');
        if(!expected||sha256!==expected)throw new Error('A integridade da cópia na nuvem não confere.');

        let parsed=null;
        try{parsed=JSON.parse(rawState)}catch{throw new Error('A cópia está íntegra, mas o conteúdo JSON não pôde ser interpretado.');}

        const summary={
          accounts:Array.isArray(parsed?.accounts)?parsed.accounts.length:0,
          cards:Array.isArray(parsed?.cards)?parsed.cards.length:0,
          investments:Array.isArray(parsed?.investments)?parsed.investments.length:0,
          debts:Array.isArray(parsed?.debts)?parsed.debts.length:0,
          movements:Array.isArray(parsed?.movements)?parsed.movements.length:0
        };

        return {
          ok:true,verified:true,snapshotId,rawState,parsed,
          schema:Number(parsed?.schema)||null,
          localSavedAt:parsed?.savedAt||meta.localSavedAt||null,
          byteLength:new TextEncoder().encode(rawState).length,
          chunkCount:count,sha256,summary
        };
      },
      async previewLatestCloudBackup(){
        const result=await this.readLatestCloudBackup();
        const {rawState,parsed,...safe}=result;
        return safe;
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

    const summarizeLocal=()=>{
      const raw=localStorage.getItem('novasol_marco_zero_state_v1')||'';
      let p={};try{p=raw?JSON.parse(raw):{}}catch{}
      return {raw,parsed:p,summary:{
        accounts:Array.isArray(p?.accounts)?p.accounts.length:0,
        cards:Array.isArray(p?.cards)?p.cards.length:0,
        investments:Array.isArray(p?.investments)?p.investments.length:0,
        debts:Array.isArray(p?.debts)?p.debts.length:0,
        movements:Array.isArray(p?.movements)?p.movements.length:0
      }};
    };
    const fmtDate=v=>{try{return v?new Date(v).toLocaleString('pt-BR'):'não informada'}catch{return 'não informada'}};
    const installRestoreControl=()=>{
      const actions=document.querySelector('.novasol-cloud-auth-actions');
      if(!actions||actions.querySelector('.novasol-cloud-restore'))return;
      const btn=document.createElement('button');
      btn.type='button';btn.className='novasol-cloud-restore';btn.textContent='Preparar restauração';
      actions.appendChild(btn);
      btn.addEventListener('click',async()=>{
        const msg=document.querySelector('.novasol-cloud-auth-msg');
        if(msg){msg.textContent='';msg.classList.remove('show','success')}
        btn.disabled=true;btn.textContent='Lendo e comparando...';
        try{
          const cloud=await api.readLatestCloudBackup();
          const local=summarizeLocal();
          let overlay=document.getElementById('novasol-cloud-restore-overlay');
          if(overlay)overlay.remove();
          overlay=document.createElement('div');overlay.id='novasol-cloud-restore-overlay';
          overlay.style.cssText='position:fixed;inset:0;background:rgba(2,12,22,.78);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px';
          const cs=cloud.summary,ls=local.summary;
          overlay.innerHTML='<div style="width:min(720px,96vw);background:#0d2638;border:1px solid #315b77;border-radius:16px;padding:22px;color:#eaf5ff;box-shadow:0 24px 70px rgba(0,0,0,.45)">'+
            '<h3 style="margin:0 0 6px">Restauração controlada da nuvem</h3>'+
            '<p style="margin:0 0 18px;color:#a9c4d6">Nada foi alterado. Confira as duas bases antes de continuar.</p>'+
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">'+
              '<div style="padding:14px;border:1px solid #284c64;border-radius:12px"><b>Este dispositivo</b><div style="margin-top:8px;line-height:1.7">'+ls.movements+' lançamentos<br>'+ls.accounts+' conta(s)<br>'+ls.cards+' cartão(ões)<br>Salva: '+fmtDate(local.parsed?.savedAt)+'</div></div>'+
              '<div style="padding:14px;border:1px solid #28765d;border-radius:12px"><b>Cópia na nuvem ✓</b><div style="margin-top:8px;line-height:1.7">'+cs.movements+' lançamentos<br>'+cs.accounts+' conta(s)<br>'+cs.cards+' cartão(ões)<br>Salva: '+fmtDate(cloud.localSavedAt)+'<br>SHA-256 OK</div></div>'+
            '</div>'+
            '<div style="margin-top:14px;padding:12px;border-radius:10px;background:#102f42;color:#bcd4e3">Ao aplicar, o NovaSol guardará primeiro uma cópia local de segurança do estado atual. Só depois substituirá a base local pela cópia validada da nuvem e recarregará o app.</div>'+
            '<label style="display:flex;gap:9px;align-items:flex-start;margin:16px 0"><input type="checkbox" class="ns-confirm-restore" style="margin-top:3px"> <span>Confirmo que quero substituir os dados deste dispositivo pela cópia da nuvem mostrada acima.</span></label>'+
            '<div style="display:flex;justify-content:flex-end;gap:10px"><button type="button" class="ns-cancel-restore">Cancelar</button><button type="button" class="ns-apply-restore" disabled>Aplicar cópia da nuvem</button></div>'+
          '</div>';
          document.body.appendChild(overlay);
          const check=overlay.querySelector('.ns-confirm-restore'),apply=overlay.querySelector('.ns-apply-restore');
          check.addEventListener('change',()=>apply.disabled=!check.checked);
          overlay.querySelector('.ns-cancel-restore').addEventListener('click',()=>overlay.remove());
          apply.addEventListener('click',()=>{
            if(!check.checked)return;
            try{
              const current=localStorage.getItem('novasol_marco_zero_state_v1');
              if(current){
                localStorage.setItem('novasol_pre_cloud_restore_v1',current);
                localStorage.setItem('novasol_pre_cloud_restore_meta_v1',JSON.stringify({savedAt:new Date().toISOString(),snapshotId:cloud.snapshotId,sha256:cloud.sha256}));
              }
              if(typeof window.novaSolApplyValidatedCloudBackup!=='function')throw new Error('A rotina nativa de restauração ainda não está disponível nesta sessão. Atualize a página.');
              const result=window.novaSolApplyValidatedCloudBackup(cloud.parsed,{snapshotId:cloud.snapshotId,sha256:cloud.sha256});
              if(!result?.ok)throw new Error(result?.message||'A rotina nativa não confirmou a restauração.');
              overlay.remove();
              if(msg){msg.textContent='✓ Cópia da nuvem aplicada pela rotina nativa: '+result.movements+' lançamentos · '+result.accounts+' conta(s) · '+result.cards+' cartão(ões).';msg.classList.add('show','success')}
            }catch(e){
              alert('A restauração não foi aplicada: '+(e?.message||e));
            }
          });
        }catch(e){
          if(msg){msg.textContent='Falha ao preparar restauração. '+(e?.message||e);msg.classList.add('show')}
        }finally{btn.disabled=false;btn.textContent='Preparar restauração'}
      });
    };
    const stampBuild=()=>{
      const foot=document.querySelector('.side .foot');if(!foot)return;
      const w=document.createTreeWalker(foot,NodeFilter.SHOW_TEXT);let n;
      while((n=w.nextNode()))if(/NovaSol v1\.0 · Build \d+/.test(n.nodeValue||''))n.nodeValue=(n.nodeValue||'').replace(/NovaSol v1\.0 · Build \d+/,'NovaSol v1.0 · Build 512');
    };
    document.addEventListener('DOMContentLoaded',()=>{setTimeout(installRestoreControl,900);setTimeout(stampBuild,900)},{once:true});
    window.addEventListener('load',()=>{setTimeout(installRestoreControl,500);setTimeout(stampBuild,500)},{once:true});
    window.addEventListener('novasol:auth-changed',()=>setTimeout(installRestoreControl,200));
    setTimeout(()=>{installRestoreControl();stampBuild()},1300);
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

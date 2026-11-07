/* ==========================================================================
   Caça-Palavras Online — videochamada WebRTC (áudio e vídeo bidirecionais).
   Sinalização por Socket.IO; servidores STUN/TURN fornecidos pelo servidor.
   Usa o padrão "perfect negotiation" (o jogador O é o lado "educado").
   ========================================================================== */
(function () {
  'use strict';

  function initVideo({ socket, emitAck, toast, sound, app, openModal, closeModal }) {
    const $ = (s) => document.querySelector(s);
    const panel = $('#video-panel');
    const remoteVideo = $('#remote-video');
    const localVideo = $('#local-video');
    const hint = $('#video-hint');
    const btnCall = $('#btn-call');
    const btnMic = $('#btn-mic');
    const btnCam = $('#btn-cam');
    const btnHang = $('#btn-hangup');
    const remoteMedia = $('#remote-media');

    let state = 'idle'; // idle | calling | ringing | connecting | connected
    let pc = null;
    let pcPromise = null;
    let localStream = null;
    let makingOffer = false;
    let ignoreOffer = false;
    let inviteTimer = null;
    let ringTimer = null;
    let micOn = true;
    let camOn = true;

    const partnerName = () => {
      const s = app.state && app.state.seats[app.seat === 'X' ? 'O' : 'X'];
      return s ? s.name : 'o teu par';
    };

    function setState(s, text) {
      state = s;
      panel.dataset.state = s;
      panel.classList.toggle('in-call', s !== 'idle');
      btnHang.disabled = s === 'idle';
      if (text) hint.textContent = text;
      refreshButtons();
    }

    function refreshButtons() {
      btnMic.classList.toggle('off', !micOn);
      btnCam.classList.toggle('off', !camOn);
      btnMic.querySelector('use').setAttribute('href', micOn ? '#i-mic' : '#i-mic-off');
      btnCam.querySelector('use').setAttribute('href', camOn ? '#i-cam' : '#i-cam-off');
      btnMic.title = micOn ? 'Desligar microfone' : 'Ligar microfone';
      btnCam.title = camOn ? 'Desligar câmara' : 'Ligar câmara';
      panel.classList.toggle('cam-off', !camOn);
      btnMic.disabled = !localStream || !localStream.getAudioTracks().length;
      btnCam.disabled = !localStream || !localStream.getVideoTracks().length;
    }

    async function getMedia() {
      if (localStream) return localStream;
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        toast('Este navegador não permite videochamada (é necessário HTTPS).', { bad: true, duration: 6000 });
        return null;
      }
      const attempts = [
        { video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }, audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } },
        { video: false, audio: true },
        { video: true, audio: false },
      ];
      for (const c of attempts) {
        try {
          localStream = await navigator.mediaDevices.getUserMedia(c);
          break;
        } catch (err) {
          if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
            toast('Permissão de câmara/microfone recusada. Podes ativá-la nas definições do navegador.', { bad: true, duration: 6000 });
            return null;
          }
        }
      }
      if (!localStream) {
        toast('Não foi encontrada câmara nem microfone. Vais apenas ver e ouvir o teu par.', { duration: 5000 });
        return null;
      }
      localVideo.srcObject = localStream;
      panel.classList.toggle('has-local', localStream.getVideoTracks().length > 0);
      micOn = true;
      camOn = localStream.getVideoTracks().length > 0;
      refreshButtons();
      return localStream;
    }

    const signal = (data) => socket.emit('rtc:signal', data);

    function ensurePC() {
      if (pcPromise) return pcPromise;
      pcPromise = (async () => {
        const cfg = await emitAck('rtc:config');
        pc = new RTCPeerConnection({ iceServers: cfg.ok ? cfg.iceServers : [{ urls: 'stun:stun.l.google.com:19302' }] });
        pc._polite = app.seat === 'O';
        if (localStream) {
          localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
          if (!localStream.getVideoTracks().length) pc.addTransceiver('video', { direction: 'recvonly' });
          if (!localStream.getAudioTracks().length) pc.addTransceiver('audio', { direction: 'recvonly' });
        } else {
          pc.addTransceiver('audio', { direction: 'recvonly' });
          pc.addTransceiver('video', { direction: 'recvonly' });
        }
        pc.ontrack = (e) => {
          const stream = e.streams[0] || new MediaStream([e.track]);
          if (remoteVideo.srcObject !== stream) remoteVideo.srcObject = stream;
          remoteVideo.volume = Number($('#vol').value) / 100;
          $('#tag-remote').textContent = partnerName();
          panel.classList.add('has-remote');
          remoteVideo.play().catch(() => {});
        };
        pc.onicecandidate = (e) => signal({ candidate: e.candidate ? e.candidate.toJSON() : null });
        pc.onnegotiationneeded = async () => {
          try {
            makingOffer = true;
            await pc.setLocalDescription();
            signal({ description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
          } catch (err) {
            console.warn('Negociação falhou', err);
          } finally {
            makingOffer = false;
          }
        };
        pc.onconnectionstatechange = () => {
          const s = pc && pc.connectionState;
          if (s === 'connected' && state !== 'connected') {
            setState('connected', 'Em chamada');
            toast('Videochamada ligada 🎥', { duration: 2000 });
          } else if (s === 'failed') {
            setState('connecting', 'A restabelecer a chamada…');
            try {
              pc.restartIce();
            } catch {
              /* ignorar */
            }
          } else if (s === 'disconnected') hint.textContent = 'Ligação instável…';
        };
        pc.oniceconnectionstatechange = () => {
          if (pc && pc.iceConnectionState === 'failed') {
            try {
              pc.restartIce();
            } catch {
              /* ignorar */
            }
          }
        };
        return pc;
      })();
      return pcPromise;
    }

    async function onSignal({ description, candidate }) {
      if (state === 'idle' || state === 'ringing') return;
      const peer = await ensurePC();
      try {
        if (description) {
          const collision = description.type === 'offer' && (makingOffer || peer.signalingState !== 'stable');
          ignoreOffer = !peer._polite && collision;
          if (ignoreOffer) return;
          await peer.setRemoteDescription(description);
          if (description.type === 'offer') {
            await peer.setLocalDescription();
            signal({ description: { type: peer.localDescription.type, sdp: peer.localDescription.sdp } });
          }
        } else if (candidate !== undefined) {
          try {
            await peer.addIceCandidate(candidate || undefined);
          } catch (err) {
            if (!ignoreOffer) console.warn('Candidato ICE rejeitado', err);
          }
        }
      } catch (err) {
        console.warn('Erro de sinalização', err);
      }
    }

    function stopRinging() {
      clearInterval(ringTimer);
      ringTimer = null;
    }

    async function start() {
      if (state !== 'idle') return;
      const other = app.state && app.state.seats[app.seat === 'X' ? 'O' : 'X'];
      if (!other || !other.connected) return toast('O outro jogador ainda não está na sala.', { duration: 2500 });
      setState('calling', 'A preparar câmara e microfone…');
      await getMedia();
      if (state !== 'calling') return;
      const res = await emitAck('rtc:invite');
      if (!res.ok) {
        toast('Não foi possível ligar ao teu par.', { bad: true });
        return cleanup();
      }
      setState('calling', `A chamar ${partnerName()}…`);
      inviteTimer = setTimeout(() => {
        if (state === 'calling') {
          toast('Sem resposta à videochamada.');
          hangup(true);
        }
      }, 45000);
    }

    async function accept() {
      closeModal('#modal-call');
      stopRinging();
      setState('connecting', 'A ligar…');
      await getMedia();
      await ensurePC();
      socket.emit('rtc:accept');
    }

    function decline() {
      closeModal('#modal-call');
      stopRinging();
      socket.emit('rtc:decline');
      cleanup();
    }

    function hangup(notify = true) {
      if (state === 'idle') return;
      if (notify) socket.emit('rtc:hangup');
      cleanup();
    }

    function cleanup() {
      clearTimeout(inviteTimer);
      stopRinging();
      closeModal('#modal-call');
      if (pc) {
        pc.ontrack = pc.onicecandidate = pc.onnegotiationneeded = pc.onconnectionstatechange = null;
        pc.close();
      }
      pc = null;
      pcPromise = null;
      makingOffer = ignoreOffer = false;
      if (localStream) localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
      localVideo.srcObject = null;
      remoteVideo.srcObject = null;
      panel.classList.remove('has-remote', 'has-local', 'cam-off');
      remoteMedia.hidden = true;
      micOn = camOn = true;
      setState('idle', 'Videochamada com o teu par');
      if (document.fullscreenElement === panel) document.exitFullscreen().catch(() => {});
    }

    socket.on('rtc:invite', ({ name }) => {
      if (!app.joined) return;
      if (state === 'calling') {
        clearTimeout(inviteTimer);
        setState('connecting', 'A ligar…');
        ensurePC().then(() => socket.emit('rtc:accept'));
        return;
      }
      if (state !== 'idle') return;
      setState('ringing', `${name} está a ligar…`);
      $('#call-from').textContent = name;
      openModal('#modal-call');
      sound.play('ring');
      ringTimer = setInterval(() => sound.play('ring'), 2500);
      setTimeout(() => state === 'ringing' && decline(), 45000);
    });
    socket.on('rtc:accept', () => {
      if (state !== 'calling' && state !== 'connecting') return;
      clearTimeout(inviteTimer);
      setState('connecting', 'A ligar…');
      ensurePC();
    });
    socket.on('rtc:decline', ({ name }) => {
      if (state === 'idle') return;
      toast(`${name} recusou a videochamada.`);
      cleanup();
    });
    socket.on('rtc:hangup', ({ name }) => {
      if (state === 'idle') return;
      toast(`${name} terminou a videochamada.`);
      cleanup();
    });
    socket.on('rtc:signal', onSignal);
    socket.on('rtc:media', ({ mic, cam, name }) => {
      const parts = [];
      if (!mic) parts.push('🔇 microfone desligado');
      if (!cam) parts.push('📷 câmara desligada');
      remoteMedia.textContent = parts.length ? `${name}: ${parts.join(' · ')}` : '';
      remoteMedia.hidden = !parts.length;
    });

    const sendMedia = () => socket.emit('rtc:media', { mic: micOn, cam: camOn });
    btnCall.addEventListener('click', start);
    btnHang.addEventListener('click', () => hangup(true));
    btnMic.addEventListener('click', () => {
      if (!localStream) return;
      micOn = !micOn;
      localStream.getAudioTracks().forEach((t) => (t.enabled = micOn));
      refreshButtons();
      sendMedia();
    });
    btnCam.addEventListener('click', () => {
      if (!localStream) return;
      camOn = !camOn;
      localStream.getVideoTracks().forEach((t) => (t.enabled = camOn));
      refreshButtons();
      sendMedia();
    });
    $('#btn-expand').addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else if (panel.requestFullscreen) panel.requestFullscreen().catch(() => {});
      else if (remoteVideo.webkitEnterFullscreen) remoteVideo.webkitEnterFullscreen();
    });
    $('#vol').addEventListener('input', (e) => {
      remoteVideo.volume = Number(e.target.value) / 100;
      remoteVideo.muted = Number(e.target.value) === 0;
    });
    $('#call-accept').addEventListener('click', accept);
    $('#call-decline').addEventListener('click', decline);
    window.addEventListener('beforeunload', () => hangup(true));

    return { hangup, get state() { return state; } };
  }

  window.CPVideo = { initVideo };
})();

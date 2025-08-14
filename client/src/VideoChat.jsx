import { useEffect, useRef, useState } from "react";
import { db } from "./firebase";
import {
    collection,
    doc,
    setDoc,
    getDoc,
    onSnapshot,
    addDoc,
} from "firebase/firestore";

const servers = {
    iceServers: [
        { urls: ["stun:stun.l.google.com:19302", "stun:stun2.l.google.com:19302"] },
    ],
};

export default function VideoChat() {
    const localVideoRef = useRef(null);
    const remoteVideoRef = useRef(null);

    const pcRef = useRef(null);
    const callRefRef = useRef(null);
    const roleRef = useRef(null);
    const remoteStreamRef = useRef(new MediaStream());

    const [callId, setCallId] = useState("");

    const initPeerConnection = () => {
        pcRef.current = new RTCPeerConnection(servers);

        navigator.mediaDevices
            .getUserMedia({ video: true, audio: true })
            .then((stream) => {
                if (localVideoRef.current) {
                    localVideoRef.current.srcObject = stream;
                }
                stream.getTracks().forEach((t) => pcRef.current.addTrack(t, stream));
            })
            .catch((err) => console.error("getUserMedia error:", err));

        pcRef.current.ontrack = (e) => {
            e.streams[0].getTracks().forEach((track) => {
                remoteStreamRef.current.addTrack(track);
            });
            if (remoteVideoRef.current) {
                remoteVideoRef.current.srcObject = remoteStreamRef.current;
                remoteVideoRef.current
                    .play()
                    .catch((err) => console.warn("Autoplay prevented:", err));
            }
            console.log("Remote track received:", e.streams[0]);
        };

        pcRef.current.onicecandidate = async (event) => {
            if (!event.candidate) return;
            const callRef = callRefRef.current;
            const role = roleRef.current;
            if (!callRef || !role) return;

            const bucket =
                role === "caller" ? "offerCandidates" : "answerCandidates";
            try {
                await addDoc(collection(callRef, bucket), event.candidate.toJSON());
                console.log("ICE candidate saved →", bucket);
            } catch (e) {
                console.error("Failed to save ICE candidate:", e);
            }
        };
    };

    const cleanup = () => {
        try {
            pcRef.current?.getSenders()?.forEach((s) => s.track?.stop());
            pcRef.current?.close();
        } catch { }

        remoteStreamRef.current = new MediaStream();
        if (remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = null;
        }
        if (localVideoRef.current) {
            localVideoRef.current.srcObject = null;
        }

        roleRef.current = null;
        callRefRef.current?._unsubs?.forEach((u) => u && u());
        callRefRef.current = null;
        setCallId("");
        initPeerConnection();
    };

    useEffect(() => {
        initPeerConnection();
        return cleanup;
    }, []);

    const createCall = async () => {
        roleRef.current = "caller";

        const callRef = doc(collection(db, "calls"));
        callRefRef.current = callRef;
        setCallId(callRef.id);
        console.log("Call ID:", callRef.id);

        const pc = pcRef.current;

        // Listen for answer candidates
        const answerCandsRef = collection(callRef, "answerCandidates");
        const stopAnswerCand = onSnapshot(answerCandsRef, (snap) => {
            snap.docChanges().forEach((change) => {
                if (change.type === "added") {
                    const data = change.doc.data();
                    pc.addIceCandidate(new RTCIceCandidate(data)).catch((e) =>
                        console.error("addIceCandidate (answer) failed:", e)
                    );
                }
            });
        });

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        console.log("Offer created:", offer);

        await setDoc(callRef, { offer: { type: offer.type, sdp: offer.sdp } });

        // Listen for remote answer or hangup
        const stopCallDoc = onSnapshot(callRef, (snap) => {
            const data = snap.data();
            if (data?.answer && !pc.currentRemoteDescription) {
                pc.setRemoteDescription(new RTCSessionDescription(data.answer)).catch(
                    (e) => console.error("setRemoteDescription(answer) failed:", e)
                );
            }
            if (data?.type === "hangup") {
                console.log("Remote peer hung up");
                cleanup();
            }
        });

        callRefRef.current._unsubs = [stopAnswerCand, stopCallDoc];
    };

    const joinCall = async () => {
        if (!callId) return alert("Enter Call ID to join");

        roleRef.current = "callee";

        const callRef = doc(collection(db, "calls"), callId);
        callRefRef.current = callRef;

        const pc = pcRef.current;

        const callSnap = await getDoc(callRef);
        const data = callSnap.data();
        if (!data?.offer) {
            alert("Offer not found for this Call ID.");
            return;
        }
        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        console.log("Answer created:", answer);

        await setDoc(
            callRef,
            { answer: { type: answer.type, sdp: answer.sdp } },
            { merge: true }
        );

        // Listen for offer ICE candidates
        const offerCandsRef = collection(callRef, "offerCandidates");
        const stopOfferCand = onSnapshot(offerCandsRef, (snap) => {
            snap.docChanges().forEach((change) => {
                if (change.type === "added") {
                    const data = change.doc.data();
                    pc.addIceCandidate(new RTCIceCandidate(data)).catch((e) =>
                        console.error("addIceCandidate (offer) failed:", e)
                    );
                }
            });
        });

        // Listen for hangup
        const stopCallDoc = onSnapshot(callRef, (snap) => {
            const newData = snap.data();
            if (newData?.type === "hangup") {
                console.log("Remote peer hung up");
                cleanup();
            }
        });

        callRefRef.current._unsubs = [stopOfferCand, stopCallDoc];
    };

    const hangUp = async () => {
        // Notify remote peer
        if (callRefRef.current) {
            await setDoc(callRefRef.current, { type: "hangup" }, { merge: true });
        }
        cleanup();
    };

    return (
        <div style={{ padding: 16 }}>
            <h2>WebRTC + Firebase Demo</h2>

            <div style={{ display: "flex", gap: 12, marginTop: 12 }}>
                <video
                    ref={localVideoRef}
                    autoPlay
                    playsInline
                    muted
                    style={{
                        width: 320,
                        height: "auto",
                        border: "1px solid #ddd",
                        borderRadius: 8,
                    }}
                />
                <video
                    ref={remoteVideoRef}
                    autoPlay
                    playsInline
                    style={{
                        width: 320,
                        height: "auto",
                        border: "1px solid #ddd",
                        borderRadius: 8,
                    }}
                />
            </div>

            <div style={{ marginTop: 12 }}>
                <button onClick={createCall}>Start Call</button>
                <input
                    type="text"
                    placeholder="Enter Call ID"
                    value={callId}
                    onChange={(e) => setCallId(e.target.value)}
                    style={{ marginLeft: 8 }}
                />
                <button onClick={joinCall} style={{ marginLeft: 8 }}>
                    Join Call
                </button>
                <button onClick={hangUp} style={{ marginLeft: 8 }}>
                    Hang Up
                </button>
            </div>
        </div>
    );
}

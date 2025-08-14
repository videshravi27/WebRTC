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

    // Refs to avoid stale-closure bugs
    const pcRef = useRef(null);
    const callRefRef = useRef(null);
    const roleRef = useRef(null); // "caller" | "callee"
    const remoteStreamRef = useRef(new MediaStream());

    const [callId, setCallId] = useState("");

    // ---------- init PC + media ----------
    useEffect(() => {
        pcRef.current = new RTCPeerConnection(servers);

        // Local media
        navigator.mediaDevices
            .getUserMedia({ video: true, audio: true })
            .then((stream) => {
                if (localVideoRef.current) localVideoRef.current.srcObject = stream;
                stream.getTracks().forEach((t) => pcRef.current.addTrack(t, stream));
            })
            .catch((err) => console.error("getUserMedia error:", err));

        // Remote media: merge tracks into one stream
        pcRef.current.ontrack = (e) => {
            e.streams[0].getTracks().forEach((track) => {
                remoteStreamRef.current.addTrack(track);
            });
            if (remoteVideoRef.current && !remoteVideoRef.current.srcObject) {
                remoteVideoRef.current.srcObject = remoteStreamRef.current;
                remoteVideoRef.current.play().catch(() => { });
            }
            console.log("Remote track received:", e.streams[0]);
        };

        // ICE: write to correct subcollection based on role
        pcRef.current.onicecandidate = async (event) => {
            if (!event.candidate) return;
            const callRef = callRefRef.current;
            const role = roleRef.current;
            if (!callRef || !role) return;

            const bucket =
                role === "caller" ? "offerCandidates" : "answerCandidates";
            try {
                await addDoc(collection(callRef, bucket), event.candidate.toJSON());
                console.log("ICE candidate saved →", bucket, event.candidate.type);
            } catch (e) {
                console.error("Failed to save ICE candidate:", e);
            }
        };

        return () => {
            // cleanup if component unmounts
            try {
                pcRef.current?.getSenders()?.forEach((s) => s.track?.stop());
                pcRef.current?.close();
            } catch { }
        };
    }, []);

    // ---------- create call (caller) ----------
    const createCall = async () => {
        roleRef.current = "caller";

        const callRef = doc(collection(db, "calls"));
        callRefRef.current = callRef;
        setCallId(callRef.id);
        console.log("Call ID:", callRef.id);

        const pc = pcRef.current;

        // Listen for callee ICE
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

        // Offer
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        console.log("Offer created:", offer);

        await setDoc(callRef, { offer: { type: offer.type, sdp: offer.sdp } });

        // Wait for answer
        const stopCallDoc = onSnapshot(callRef, (snap) => {
            const data = snap.data();
            if (data?.answer && !pc.currentRemoteDescription) {
                pc.setRemoteDescription(new RTCSessionDescription(data.answer)).catch(
                    (e) => console.error("setRemoteDescription(answer) failed:", e)
                );
            }
        });

        // store unsubscribers on the ref so we can clean later if needed
        callRefRef.current._unsubs = [stopAnswerCand, stopCallDoc];
    };

    // ---------- join call (callee) ----------
    const joinCall = async () => {
        if (!callId) return alert("Enter Call ID to join");

        roleRef.current = "callee";

        const callRef = doc(collection(db, "calls"), callId);
        callRefRef.current = callRef;

        const pc = pcRef.current;

        // Read offer
        const callSnap = await getDoc(callRef);
        const data = callSnap.data();
        if (!data?.offer) {
            alert("Offer not found for this Call ID.");
            return;
        }
        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));

        // Answer
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        console.log("Answer created:", answer);

        await setDoc(
            callRef,
            { answer: { type: answer.type, sdp: answer.sdp } },
            { merge: true }
        );

        // Listen for caller ICE
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

        callRefRef.current._unsubs = [stopOfferCand];
    };

    // ---------- hang up / cleanup ----------
    const hangUp = async () => {
        try {
            pcRef.current.getSenders().forEach((s) => s.track?.stop());
            pcRef.current.close();
        } catch { }
        // (optional) delete doc/collections in Firestore here if you want
        // await deleteDoc(callRefRef.current)
        roleRef.current = null;
        callRefRef.current?._unsubs?.forEach((u) => u && u());
        callRefRef.current = null;
        setCallId("");
        // Recreate a new RTCPeerConnection for next call
        pcRef.current = new RTCPeerConnection(servers);
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
                    style={{ width: 320, height: "auto", border: "1px solid #ddd", borderRadius: 8 }}
                />
                <video
                    ref={remoteVideoRef}
                    autoPlay
                    playsInline
                    style={{ width: 320, height: "auto", border: "1px solid #ddd", borderRadius: 8 }}
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
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Mic, MicOff, Loader2, WifiOff } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useInterview } from '@/contexts/InterviewContext';

interface DeepgramTranscriptionClientProps {
  speakerName: string;
  speakerRole: 'Interviewer' | 'Candidate';
  roomId: string;
}

export const DeepgramTranscriptionClient: React.FC<DeepgramTranscriptionClientProps> = ({
  speakerName,
  speakerRole,
  roomId
}) => {
  const [isProcessing, setIsProcessing] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [networkError, setNetworkError] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');
  
  // Refs
  const socketRef = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const clientIdRef = useRef<string | null>(null);
  
  const { toast } = useToast();
  const { setIsRecording: setContextIsRecording, addTranscriptLine } = useInterview();
  
  // Check network status
  useEffect(() => {
    const handleOnline = () => setNetworkError(false);
    const handleOffline = () => {
      setNetworkError(true);
      if (isRecording) {
        toast({
          title: 'Network Connection Lost',
          description: 'Speech recognition paused due to network issues.',
          variant: 'destructive'
        });
        stopRecording();
      }
    };
    
    // Initial check
    setNetworkError(!navigator.onLine);
    
    // Add listeners
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [isRecording, toast]);
  
  // Clean up on unmount
  useEffect(() => {
    return () => {
      stopRecording();
    };
  }, []);
  
  // Update context isRecording state when local state changes
  useEffect(() => {
    setContextIsRecording(isRecording);
  }, [isRecording, setContextIsRecording]);
  
  // Function to connect to the WebSocket server
  const connectWebSocket = useCallback(() => {
    if (socketRef.current && (socketRef.current.readyState === WebSocket.OPEN || socketRef.current.readyState === WebSocket.CONNECTING)) {
      return;
    }
    
    setConnectionStatus('connecting');
    
    // Create WebSocket URL with room and identity parameters
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsHost = process.env.REACT_APP_WS_HOST || window.location.hostname + ':3000';
    const wsUrl = `${wsProtocol}//${wsHost}?room=${roomId}&identity=${encodeURIComponent(speakerName)}`;
    
    console.log(`Connecting to WebSocket server: ${wsUrl}`);
    
    const socket = new WebSocket(wsUrl);
    socketRef.current = socket;
    
    socket.onopen = () => {
      console.log('WebSocket connection established');
      setConnectionStatus('connected');
    };
    
    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        
        switch (data.type) {
          case 'room-info':
            console.log(`Joined room: ${data.roomName}`);
            clientIdRef.current = data.clientId;
            break;
            
          case 'can-open-mic':
            console.log('Server ready to receive audio');
            if (streamRef.current) {
              setupMediaRecorder(streamRef.current);
            }
            break;
            
          case 'transcript-result':
            if (data.text && data.text.trim()) {
              // Add transcript to the UI
              addTranscriptLine({
                speaker: data.speaker,
                text: data.text
              });
            }
            break;
            
          case 'error':
            console.error('Server error:', data.message);
            toast({
              title: 'Transcription Error',
              description: data.message || 'An error occurred with the transcription service',
              variant: 'destructive'
            });
            break;
            
          case 'participant-joined':
          case 'participant-left':
            // Handle participant events if needed
            break;
            
          default:
            console.log('Received message:', data);
        }
      } catch (error) {
        console.error('Error processing WebSocket message:', error);
      }
    };
    
    socket.onerror = (error) => {
      console.error('WebSocket connection error:', error);
      setConnectionStatus('disconnected');
      toast({
        title: 'Connection Error',
        description: 'Error connecting to transcription service.',
        variant: 'destructive'
      });
    };
    
    socket.onclose = (event) => {
      console.log(`WebSocket connection closed. Code: ${event.code}`);
      setConnectionStatus('disconnected');
      socketRef.current = null;
      
      if (isRecording) {
        stopRecording();
      }
    };
  }, [roomId, speakerName, toast, isRecording, addTranscriptLine]);
  
  // Function to stop recording
  const stopRecording = useCallback(() => {
    // Only log if actually stopping something
    if (mediaRecorderRef.current || streamRef.current) {
      console.log('Stopping speech recognition');
    }
    
    // Stop media recorder
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop();
      } catch (error) {
        console.error('Error stopping MediaRecorder:', error);
      }
      mediaRecorderRef.current = null;
    }
    
    // Stop and release media stream
    if (streamRef.current) {
      try {
        streamRef.current.getTracks().forEach(track => track.stop());
      } catch (error) {
        console.error('Error stopping media tracks:', error);
      }
      streamRef.current = null;
    }
    
    setIsRecording(false);
  }, []);
  
  // Function to start recording
  const startRecording = useCallback(async () => {
    if (networkError) {
      toast({
        title: 'Network Error',
        description: 'Cannot start speech recognition without internet connection.',
        variant: 'destructive'
      });
      return;
    }
    
    setIsProcessing(true);
    console.log('Starting speech recognition...');
    
    try {
      // Stop any existing recording
      stopRecording();
      
      // Get microphone access
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        } 
      });
      
      streamRef.current = stream;
      
      // Connect to WebSocket server if not already connected
      if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
        connectWebSocket();
      } else if (socketRef.current.readyState === WebSocket.OPEN) {
        // If already connected, set up media recorder directly
        setupMediaRecorder(stream);
      }
      
    } catch (error) {
      console.error('Error starting recording:', error);
      toast({
        title: 'Recording Error',
        description: 'Failed to start recording. Please check your microphone permissions.',
        variant: 'destructive'
      });
      
      stopRecording();
    } finally {
      setIsProcessing(false);
    }
  }, [networkError, toast, stopRecording, connectWebSocket]);
  
  // Helper function to set up MediaRecorder
  const setupMediaRecorder = (stream: MediaStream) => {
    // Check for supported MIME types
    let mimeType = 'audio/webm';
    
    // Check if the browser supports the preferred MIME type
    if (!MediaRecorder.isTypeSupported('audio/webm')) {
      if (MediaRecorder.isTypeSupported('audio/ogg')) {
        mimeType = 'audio/ogg';
      } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
        mimeType = 'audio/mp4';
      } else {
        mimeType = ''; // Let the browser use its default
      }
    }
    
    const mediaRecorder = new MediaRecorder(stream, {
      mimeType: mimeType || undefined,
      audioBitsPerSecond: 128000
    });
    
    mediaRecorderRef.current = mediaRecorder;
    
    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0 && socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
        socketRef.current.send(event.data);
      }
    };
    
    mediaRecorder.onstart = () => {
      setIsRecording(true);
    };
    
    mediaRecorder.onerror = (event) => {
      console.error('MediaRecorder error:', event);
    };
    
    mediaRecorder.start(250); // Send data every 250ms
  };
  
  return (
    <div className="flex items-center">
      <Button
        variant={isRecording ? "destructive" : "outline"}
        size="sm"
        onClick={isRecording ? stopRecording : startRecording}
        disabled={isProcessing || networkError}
        className={isRecording ? "bg-red-600 hover:bg-red-700" : "border-tech-green text-tech-green hover:bg-tech-green/10"}
      >
        {isProcessing ? (
          <>
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            Initializing...
          </>
        ) : isRecording ? (
          <>
            <MicOff className="w-4 h-4 mr-2" />
            Stop Recording
          </>
        ) : (
          <>
            <Mic className="w-4 h-4 mr-2" />
            Start Recording
          </>
        )}
      </Button>
      
      {isRecording && (
        <span className="ml-3 text-tech-green flex items-center">
          <span className="w-2 h-2 bg-tech-green rounded-full mr-2 animate-pulse"></span>
          Recording as {speakerName}
        </span>
      )}
      
      {networkError && (
        <span className="ml-3 text-red-500 flex items-center">
          <WifiOff className="w-4 h-4 mr-1" />
          Network error
        </span>
      )}
      
      {!networkError && connectionStatus === 'connecting' && (
        <span className="ml-3 text-yellow-500 flex items-center">
          <Loader2 className="w-4 h-4 mr-1 animate-spin" />
          Connecting...
        </span>
      )}
    </div>
  );
};

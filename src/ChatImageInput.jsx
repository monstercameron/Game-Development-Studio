import { useRef, useState } from 'react';
import { FolderOpen, ImagePlus, X } from 'lucide-react';
import AssetPicker from './AssetPicker';
import { IMAGE_EXTENSIONS } from './asset-picker.js';
import {
  CHAT_IMAGE_SOURCE_MAX_BYTES,
  MAX_CHAT_IMAGES,
  MAX_CHAT_IMAGES_TOTAL_BYTES,
} from '../runtime/chat-image-limits.js';
import './chat-images.css';

const ACCEPTED_TYPES = 'image/png,image/jpeg,image/webp';

/** Thumbnails of the pictures that will be sent with the next message. */
export function ChatImageTray({ attachments, onRemove, disabled }) {
  if (!attachments.length) {
    return null;
  }
  return (
    <div className="chat-image-attachments">
      <ul className="chat-image-tray" aria-label="Pictures attached to the next message">
        {attachments.map((image, index) => (
          <li key={image.id} className="chat-image-chip">
            <img
              src={image.thumb}
              alt={`Attached picture ${index + 1} of ${attachments.length}: ${image.name}`}
            />
            <span className="chat-image-chip-name" title={image.name}>
              {image.name}
              {image.resized ? ` (shrunk to ${image.width}×${image.height})` : ''}
            </span>
            <button
              type="button"
              className="chat-image-remove"
              aria-label={`Remove picture ${image.name}`}
              disabled={disabled}
              onClick={() => onRemove(image.id)}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
      <p className="chat-image-reason">
        Sent with this message only; later turns see your text and the answer. Each picture uses
        part of the context window.
      </p>
    </div>
  );
}

/** Attach buttons for a file, or a picture from the project asset library. */
export function ChatImageButtons({
  attachments,
  preparing,
  blockedReason,
  busy,
  project,
  onFiles,
  onProblem,
}) {
  const fileInput = useRef(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const isFull = attachments.length >= MAX_CHAT_IMAGES;
  const reason =
    blockedReason ||
    (isFull
      ? `A message can carry up to ${MAX_CHAT_IMAGES} pictures. Remove one to add another.`
      : '');
  const isDisabled = Boolean(reason) || busy || preparing;
  const reasonId = 'chat-image-reason';
  return (
    <div className="chat-image-buttons">
      <input
        ref={fileInput}
        type="file"
        accept={ACCEPTED_TYPES}
        multiple
        hidden
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const files = [...event.target.files];
          event.target.value = '';
          onFiles(files);
        }}
      />
      <button
        type="button"
        className="chat-image-attach"
        disabled={isDisabled}
        aria-describedby={reason ? reasonId : undefined}
        title={reason || 'Attach pictures from this computer (PNG, JPEG or WebP)'}
        onClick={() => fileInput.current?.click()}
      >
        <ImagePlus size={16} aria-hidden="true" />
        <span>{preparing ? 'Preparing…' : 'Attach image'}</span>
      </button>
      <button
        type="button"
        className="chat-image-attach"
        disabled={isDisabled || !project}
        aria-describedby={reason ? reasonId : undefined}
        title={
          reason ||
          (project ? 'Choose a picture from the project assets' : 'Choose a project first')
        }
        onClick={() => setPickerOpen(true)}
      >
        <FolderOpen size={16} aria-hidden="true" />
        <span>From project</span>
      </button>
      {reason && !busy && (
        <p id={reasonId} className="chat-image-reason">
          {reason}
        </p>
      )}
      {pickerOpen && project && (
        <AssetPicker
          title="Choose pictures for the chat"
          description="PNG, JPEG or WebP pictures from this project. They are shrunk to fit before sending."
          projects={[project]}
          project={project}
          extensions={IMAGE_EXTENSIONS}
          maxFiles={MAX_CHAT_IMAGES - attachments.length}
          maxBytes={CHAT_IMAGE_SOURCE_MAX_BYTES}
          totalBytes={MAX_CHAT_IMAGES_TOTAL_BYTES}
          onClose={() => setPickerOpen(false)}
          onSelect={(files) => {
            setPickerOpen(false);
            if (!files.length) {
              onProblem('No picture was selected.');
              return;
            }
            onFiles(files);
          }}
        />
      )}
    </div>
  );
}

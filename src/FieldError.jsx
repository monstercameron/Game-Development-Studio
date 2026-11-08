import { CircleAlert } from 'lucide-react';
import './field-error.css';

// The message for one invalid field. It is announced when it appears, stays beside the field,
// and is focusable (not in the tab order) so focus has somewhere to land when the control
// itself is not on the page, for example a file that must be chosen again.
export default function FieldError({ id, message }) {
  if (!message) {
    return null;
  }
  return (
    <p id={id} className="creation-field-error" role="alert" tabIndex={-1}>
      <CircleAlert size={15} aria-hidden="true" />
      <span>{message}</span>
    </p>
  );
}

// Form engine (client). Progressive enhancement over the plain form in Form.astro:
// steps, inline errors, attribution, Turnstile token, JSON submit, then the file upload if one was chosen.

const MESSAGES = {
  required: "Please fill this in.",
  invalid_email: "Please enter a valid email address.",
  invalid_phone: "Please enter a valid phone number.",
  invalid_url: "Please enter a full web address, starting with https://",
  invalid_option: "Please choose one of the options.",
  too_long: "That's too long.",
  file_type: "That file type isn't accepted.",
  file_too_large: "That file is too large.",
  file_size: "That file couldn't be read.",
};
const GENERAL = {
  turnstile_failed: "The spam check didn't pass. Please try again.",
  turnstile_missing: "Please wait for the spam check to finish, then send again.",
  rate_limited: "Too many tries in a short time. Please wait a minute and try again.",
  default: "Something went wrong and your message wasn't sent. Please try again.",
};

function readAttribution() {
  try {
    return JSON.parse(localStorage.getItem("fb_attr") || "{}");
  } catch {
    return {};
  }
}

function setError(form, name, code) {
  const el = form.querySelector(`[data-fb-error="${name}"]`);
  const input = name === "file" ? form.querySelector("[data-fb-file]") : form.elements[name];
  if (el) el.textContent = code ? MESSAGES[code] || MESSAGES.required : "";
  if (input && input.setAttribute) {
    if (code) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
  }
}

function clearErrors(form) {
  form.querySelectorAll("[data-fb-error]").forEach((el) => setError(form, el.dataset.fbError, null));
}

function nativeCode(input) {
  const v = input.validity;
  if (v.valueMissing) return "required";
  if (v.typeMismatch) return input.type === "email" ? "invalid_email" : input.type === "url" ? "invalid_url" : "required";
  if (v.tooLong) return "too_long";
  return "required";
}

// Returns true when every field in the container is valid; marks the invalid ones.
function validate(form, container) {
  let first = null;
  container.querySelectorAll("input[name], textarea[name], select[name]").forEach((input) => {
    if (input.name === "website" || input.type === "hidden") return;
    if (input.checkValidity()) {
      setError(form, input.name, null);
    } else {
      setError(form, input.name, nativeCode(input));
      first = first || input;
    }
  });
  const file = container.querySelector("[data-fb-file]");
  if (file && file.files[0]) {
    const f = file.files[0];
    const max = Number(file.dataset.maxBytes);
    const types = file.accept.split(",");
    const code = f.size > max ? "file_too_large" : !types.includes(f.type) ? "file_type" : null;
    setError(form, "file", code);
    if (code) first = first || file;
  }
  if (first) first.focus();
  return !first;
}

function showStep(form, index) {
  const steps = [...form.querySelectorAll("[data-fb-step]")];
  steps.forEach((s, i) => (s.hidden = i !== index));
  const progress = form.querySelector("[data-fb-progress]");
  if (progress) progress.textContent = `Step ${index + 1} of ${steps.length}`;
  steps[index].querySelector("input, textarea, select, button")?.focus();
  return index;
}

function upload(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("content-type", file.type);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(String(xhr.status))));
    xhr.onerror = () => reject(new Error("network"));
    xhr.send(file);
  });
}

function wire(form) {
  form.noValidate = true; // the engine reports errors itself, inline
  const status = form.querySelector("[data-fb-status]");
  const steps = [...form.querySelectorAll("[data-fb-step]")];
  let current = 0;

  form.addEventListener("click", (e) => {
    if (e.target.closest("[data-fb-next]")) {
      if (validate(form, steps[current])) current = showStep(form, current + 1);
    } else if (e.target.closest("[data-fb-back]")) {
      current = showStep(form, current - 1);
    }
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearErrors(form);
    status.textContent = "";
    if (!validate(form, steps[current])) return;

    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    status.textContent = "Sending…";

    const data = {};
    for (const el of form.elements) {
      if (!el.name || el.type === "file") continue;
      if (el.type === "checkbox") data[el.name] = el.checked;
      else data[el.name] = el.value;
    }
    for (const [k, v] of Object.entries(readAttribution())) data[`attr_${k}`] = v;
    data.page = location.pathname;
    const fileInput = form.querySelector("[data-fb-file]");
    const file = fileInput?.files[0];
    if (file) Object.assign(data, { file_name: file.name, file_size: file.size, file_type: file.type });

    try {
      const res = await fetch(form.action, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(data),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok || !out.ok) {
        if (out.fields) {
          for (const [name, code] of Object.entries(out.fields)) setError(form, name, code);
          const stepWithError = steps.findIndex((s) => s.querySelector('[aria-invalid="true"]'));
          if (stepWithError >= 0 && stepWithError !== current) current = showStep(form, stepWithError);
          form.querySelector('[aria-invalid="true"]')?.focus();
          status.textContent = "Please check the highlighted fields.";
        } else {
          status.textContent = GENERAL[out.error] || GENERAL.default;
        }
        window.turnstile?.reset?.(form.querySelector(".cf-turnstile"));
        button.disabled = false;
        return;
      }
      if (out.upload && file) {
        status.textContent = "Uploading your file…";
        try {
          await upload(out.upload.url, file, (p) => (status.textContent = `Uploading your file… ${p}%`));
        } catch {
          // The message is saved either way; tell the visitor the file didn't make it.
          location.assign(`${out.redirect}#file-failed`);
          return;
        }
      }
      location.assign(out.redirect);
    } catch {
      status.textContent = GENERAL.default;
      button.disabled = false;
    }
  });
}

document.querySelectorAll("form[data-fb-form]").forEach(wire);

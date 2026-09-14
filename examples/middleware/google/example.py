"""Native Google chat example; all network endpoints and model IDs are explicit."""
import httpx
from google import genai
from google.genai import types
from caveman_middleware.google import CavemanGoogleTransport, with_caveman_google_chat


def answer_from_logs(*, native_options, provider_base_url, runtime, scope, model, source, question):
    """The application keeps its provider/auth options and existing runtime."""
    def read_logs() -> str:
        """Read the diagnostic log."""
        return source

    existing = native_options.get("http_options")
    existing = types.HttpOptions(**existing) if isinstance(existing, dict) else existing or types.HttpOptions()
    if existing.httpx_client is not None:
        raise ValueError("Configure CavemanGoogleTransport on the existing HTTPX client when constructing it")
    # Preserve the application's public HTTPX arguments and selected transport.
    client_args = dict(existing.client_args or {})
    original_transport = client_args.pop("transport", None)
    transport = CavemanGoogleTransport(runtime=runtime, scope=scope, provider_base_url=provider_base_url, transport=original_transport)
    with httpx.Client(**client_args, transport=transport) as http:
        http_options = existing.model_copy(update={"httpx_client": http})
        with genai.Client(**{**native_options, "http_options": http_options}) as client:
            config = types.GenerateContentConfig(tools=[read_logs])
            chat = with_caveman_google_chat(client.chats.create(model=model, config=config), runtime=runtime, scope=scope, config=config)
            return chat.send_message(question)

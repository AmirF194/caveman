"""Capture metadata from a real optimizer client, never a substitute runtime."""
from caveman_cloud.middleware import MiddlewareRuntime


class EvidenceRuntime(MiddlewareRuntime):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.plans, self.receipts = [], []

    def optimize(self, **kwargs):
        result = super().optimize(**kwargs)
        self.plans.append((kwargs.get("model"), result))
        return result

    def observe_background(self, receipt):
        self.receipts.append(receipt)
        return super().observe_background(receipt)

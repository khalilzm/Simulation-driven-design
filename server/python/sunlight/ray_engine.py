"""Compatibility entry point; use the maintained Honeybee-grid ray engine."""

from __future__ import annotations

from typing import Any, Dict

from lb_direct_sun import run_honeybee_direct_sun


def run_ladybug_rays(model: Dict[str, Any], config: Dict[str, Any]) -> Dict[str, Any]:
    return run_honeybee_direct_sun(model, config)

"""Collectors normalize external activity sources into ``Event`` objects.

Each collector is a pure-ish reader: it reads from the outside world and yields
``Event`` instances. It never writes to its source and never decides routing —
it only tags ``sensitivity`` at collection time (design §4/§8).
"""

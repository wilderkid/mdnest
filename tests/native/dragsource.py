#!/usr/bin/python3
# Minimal GTK3 drag source for native drop tests: a window at (X,Y) that drags the given files as text/uri-list.
import sys, gi
gi.require_version("Gtk", "3.0"); gi.require_version("Gdk", "3.0")
from gi.repository import Gtk, Gdk
x, y, files = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3:]
uris = ["file://" + f for f in files]
w = Gtk.Window(title="mdn-dragsource"); w.set_default_size(170, 140); w.move(x, y)
b = Gtk.EventBox(); b.add(Gtk.Label(label="drag me\n" + "\n".join(f.split("/")[-1] for f in files))); w.add(b)
b.drag_source_set(Gdk.ModifierType.BUTTON1_MASK, [], Gdk.DragAction.COPY); b.drag_source_add_uri_targets()
b.connect("drag-data-get", lambda _w, _c, data, _i, _t: data.set_uris(uris))
b.connect("drag-end", lambda *_: print("drag-end", flush=True))
w.connect("destroy", Gtk.main_quit); w.show_all(); print("ready", flush=True); Gtk.main()

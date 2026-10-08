#!/usr/bin/env python3
"""Draws the Windows installer pictures (src-tauri/windows/*.bmp) from the app icon.
Needs Pillow and fontTools:  python3 scripts/installer-art.py
Uses the Inter font bundled in app/renderer/vendor/inter."""
import os, sys, tempfile
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
tmp=tempfile.mkdtemp()
for w in (700,500):
    f=TTFont(os.path.join(ROOT,'app/renderer/vendor/inter/inter-latin-opsz-normal.woff2')); f.flavor=None
    instancer.instantiateVariableFont(f,{"wght":w,"opsz":32 if w==700 else 14}).save(os.path.join(tmp,f'inter-{w}.ttf'))
sys.argv=[sys.argv[0], tmp, os.path.join(ROOT,'src-tauri/windows'), os.path.join(ROOT,'build/icon.png')]
from PIL import Image, ImageDraw, ImageFont, ImageFilter
S=sys.argv[1]; OUT=sys.argv[2]; ICON=sys.argv[3]
K=4
B=ImageFont.truetype(S+'/inter-700.ttf', 22*K)
M=ImageFont.truetype(S+'/inter-500.ttf', 12*K)
Sm=ImageFont.truetype(S+'/inter-500.ttf', 10.5*K)
icon=Image.open(ICON).convert('RGBA')

def sidebar():
    W,H=164*K,314*K
    im=Image.new('RGB',(W,H))
    top,bot=(30,30,46),(14,14,22)
    d=ImageDraw.Draw(im)
    for y in range(H):
        t=y/H; d.line([(0,y),(W,y)],fill=tuple(int(top[i]+(bot[i]-top[i])*t) for i in range(3)))
    # soft blue light behind the logo
    glow=Image.new('L',(W,H),0); g=ImageDraw.Draw(glow)
    g.ellipse([-40*K,-20*K,150*K,150*K],fill=60)
    glow=glow.filter(ImageFilter.GaussianBlur(38*K))
    blue=Image.new('RGB',(W,H),(137,180,250))
    im=Image.composite(blue,im,glow)
    d=ImageDraw.Draw(im)
    # logo with a soft shadow
    L=60*K; x0,y0=22*K,40*K
    lg=icon.resize((L,L),Image.LANCZOS)
    sh=Image.new('L',(W,H),0); ImageDraw.Draw(sh).rounded_rectangle([x0+2*K,y0+6*K,x0+L-2*K,y0+L+4*K],radius=14*K,fill=150)
    sh=sh.filter(ImageFilter.GaussianBlur(7*K))
    im=Image.composite(Image.new('RGB',(W,H),(0,0,0)),im,sh)
    im.paste(lg,(x0,y0),lg)
    d=ImageDraw.Draw(im)
    tx=22*K
    d.text((tx,122*K),"Bible",font=B,fill=(228,232,251))
    d.text((tx,148*K),"Presenter",font=B,fill=(228,232,251))
    d.line([(tx,186*K),(W-22*K,186*K)],fill=(58,58,82),width=K)
    for i,t in enumerate(["Verses & lyrics","Slides & video","Live to vMix & OBS","Phone remote"]):
        y=(202+i*20)*K
        d.ellipse([tx,y+5*K,tx+5*K,y+10*K],fill=(137,180,250))
        d.text((tx+12*K,y-1*K),t,font=M,fill=(186,194,222))
    d.text((tx,288*K),"Free · Windows & macOS",font=Sm,fill=(108,112,134))
    return im.resize((164,314),Image.LANCZOS)

def header():
    W,H=150*K,57*K
    im=Image.new('RGB',(W,H),(255,255,255))
    L=36*K; x0=(10)*K; y0=(H-L)//2
    lg=icon.resize((L,L),Image.LANCZOS)
    im.paste(lg,(x0,y0),lg)
    d=ImageDraw.Draw(im)
    F=ImageFont.truetype(S+'/inter-700.ttf', 13.5*K)
    d.text((x0+L+9*K,y0+1*K),"Bible",font=F,fill=(30,30,46))
    d.text((x0+L+9*K,y0+18*K),"Presenter",font=F,fill=(30,30,46))
    return im.resize((150,57),Image.LANCZOS)

sidebar().save(OUT+'/installerSidebar.bmp')
header().save(OUT+'/installerHeader.bmp')

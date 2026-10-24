package com.amagos.game;

import org.libsdl.app.SDLActivity;

/** SDL3 가 libSDL3.so·libmain.so 를 읽어 c/platform/main_sdl.c 의 SDL_App* 콜백을 돌린다. */
public class AmagosActivity extends SDLActivity {
    @Override
    protected String[] getLibraries() {
        return new String[] { "SDL3", "main" };
    }
}

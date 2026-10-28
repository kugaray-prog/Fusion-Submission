import React, { useEffect, useRef, useState } from 'react';
import { Animated } from 'react-native';

// Fade/slide-in on mount. The animated style is dropped once done so content
// can't stay stuck invisible (seen on some Android phones).
export default function FadeIn({ children, delay = 0, duration = 380, distance = 14, style }) {
  const progress = useRef(new Animated.Value(0)).current;
  const [done, setDone] = useState(false);

  useEffect(() => {
    let mounted = true;
    const finish = () => { if (mounted) setDone(true); };
    const anim = Animated.timing(progress, {
      toValue: 1,
      duration,
      delay,
      useNativeDriver: true,
    });
    anim.start(finish);
    const fallback = setTimeout(finish, delay + duration + 150);
    return () => {
      mounted = false;
      clearTimeout(fallback);
      anim.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Animated.View
      style={
        done
          ? style
          : [
              style,
              {
                opacity: progress,
                transform: [
                  {
                    translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [distance, 0] }),
                  },
                ],
              },
            ]
      }
    >
      {children}
    </Animated.View>
  );
}
